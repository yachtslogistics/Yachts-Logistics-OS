// Yachts Logistics OS — Outreach Writer v2.1
//
// Generates personalized EMAIL DRAFTS only. Never sends email.
// Uses AI Router v2, so the Settings button can switch OpenAI Luna ON/OFF
// and Gemini automatically takes over when OpenAI is paused, paced, exhausted,
// or unavailable.
//
// Important reliability choice: the model NEVER chooses or invents an email
// address. Recipient addresses come only from VERIFIED contacts already stored
// in Supabase. The model returns only prospect_id + subject + body.
//
// Required Worker variables/secrets:
//   AI_ROUTER_URL           Plain text
//   ROUTER_SECRET           Secret
//   SUPABASE_URL            Plain text
//   SUPABASE_SERVICE_KEY    Secret
//   WORKER_SECRET           Secret
//
// Recommended Cron only AFTER dry-run + live test succeed:
//   45 */6 * * *  (4 AI requests/day if every run has work)

const DEFAULT_BATCH_SIZE = 5;
const MAX_BATCH_SIZE = 8;
const MIN_PROSPECT_SCORE = 70;

const BLOCKED_NAMES = [
  'asyad', 'asyad group', 'asyad shipping', 'asyad shipping company',
  'asyad ports', 'oman global logistics group'
];

export default {
  async fetch(request, env) {
    const providedSecret = request.headers.get('x-worker-secret');
    if (!env.WORKER_SECRET || providedSecret !== env.WORKER_SECRET) {
      return jsonResponse(401, { error: 'Missing or incorrect x-worker-secret header.' });
    }

    const url = new URL(request.url);
    const requestedBatch = Number.parseInt(url.searchParams.get('batch') || String(DEFAULT_BATCH_SIZE), 10);
    const batchSize = Number.isFinite(requestedBatch)
      ? Math.max(1, Math.min(requestedBatch, MAX_BATCH_SIZE))
      : DEFAULT_BATCH_SIZE;
    const isLive = url.searchParams.get('live') === 'true';

    const result = await runWriter(env, batchSize, isLive);
    return jsonResponse(result.status, result.body);
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runWriter(env, DEFAULT_BATCH_SIZE, true));
  }
};

async function runWriter(env, batchSize, isLive) {
  const missing = ['AI_ROUTER_URL', 'ROUTER_SECRET', 'SUPABASE_URL', 'SUPABASE_SERVICE_KEY']
    .filter(name => !env[name]);
  if (missing.length) return { status: 500, body: { error: 'Missing Worker variables.', missing } };

  const sbHeaders = {
    apikey: env.SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json'
  };

  try {
    const [profile, prospects, contacts, drafts] = await Promise.all([
      fetchCompanyProfile(env.SUPABASE_URL, sbHeaders),
      fetchCandidateProspects(env.SUPABASE_URL, sbHeaders, Math.max(50, batchSize * 10)),
      fetchVerifiedContacts(env.SUPABASE_URL, sbHeaders),
      fetchExistingDraftProspectIds(env.SUPABASE_URL, sbHeaders)
    ]);

    if (!prospects.ok) return { status: 500, body: { error: `Could not read prospects: ${prospects.error}` } };
    if (!contacts.ok) return { status: 500, body: { error: `Could not read contacts: ${contacts.error}` } };
    if (!drafts.ok) return { status: 500, body: { error: `Could not read existing drafts: ${drafts.error}` } };

    const bestContactByProspect = new Map();
    for (const contact of contacts.rows) {
      if (!contact.prospect_id || !contact.email || contact.verified !== true) continue;
      if (!bestContactByProspect.has(contact.prospect_id)) bestContactByProspect.set(contact.prospect_id, contact);
    }

    const targets = prospects.rows
      .filter(p => !BLOCKED_NAMES.some(name => normalizeCompanyName(p.company_name).includes(name)))
      .filter(p => !drafts.ids.has(p.id))
      .filter(p => bestContactByProspect.has(p.id))
      .slice(0, batchSize)
      .map(p => ({ ...p, contact: bestContactByProspect.get(p.id) }));

    if (!targets.length) {
      const reason = `No researched prospects scoring ${MIN_PROSPECT_SCORE}+ with a verified business email are waiting for a first draft.`;
      await logActivity(env.SUPABASE_URL, sbHeaders, `Skipped — ${reason}`, { live: isLive });
      return { status: 200, body: { drafted: 0, reason } };
    }

    const prompt = buildPrompt(profile, targets);
    const routed = await callRouter(env, {
      task_type: 'outreach_draft',
      worker_name: 'Outreach Writer',
      prompt,
      max_output_tokens: 4500
    });

    if (!routed.ok) {
      const action = routed.status === 429
        ? 'Skipped — AI Router has both providers protected or unavailable.'
        : `Outreach Writer failed — AI Router returned HTTP ${routed.status}.`;
      await logActivity(env.SUPABASE_URL, sbHeaders, action, {
        live: isLive,
        router_error: clip(routed.error, 1000),
        router_detail: routed.data || null,
        companies: targets.map(t => t.company_name)
      });
      return { status: routed.status === 429 ? 200 : 502, body: routed.status === 429 ? { skipped: true, reason: routed.error, router: routed.data } : { error: routed.error, router: routed.data } };
    }

    const parsed = parseDraftArray(routed.output);
    if (!parsed.ok) {
      await logActivity(env.SUPABASE_URL, sbHeaders, 'Outreach Writer failed — routed AI output was not valid draft JSON.', {
        provider: routed.provider,
        error: parsed.error,
        response_excerpt: clip(routed.output, 1000),
        live: isLive
      });
      return { status: 502, body: { error: parsed.error, provider: routed.provider } };
    }

    const targetById = new Map(targets.map(t => [String(t.id), t]));
    const accepted = [];
    const rejected = [];
    const seen = new Set();

    for (const item of parsed.rows) {
      const prospectId = cleanString(item.prospect_id, 120);
      const subject = cleanString(item.subject, 220);
      const body = cleanString(item.body, 8000);

      if (!prospectId || !targetById.has(prospectId)) {
        rejected.push({ prospect_id: prospectId, reason: 'Unknown prospect_id returned by model.' });
        continue;
      }
      if (seen.has(prospectId)) {
        rejected.push({ prospect_id: prospectId, reason: 'Duplicate draft returned by model.' });
        continue;
      }
      if (!subject || !body) {
        rejected.push({ prospect_id: prospectId, reason: 'Missing subject or body.' });
        continue;
      }

      const target = targetById.get(prospectId);
      // Recipient is copied ONLY from the verified DB contact, never from model output.
      accepted.push({
        prospect_id: target.id,
        company_name: target.company_name,
        recipient_email: target.contact.email,
        subject,
        body
      });
      seen.add(prospectId);
    }

    if (!accepted.length) {
      await logActivity(env.SUPABASE_URL, sbHeaders, 'Outreach Writer failed — no usable drafts survived validation.', {
        provider: routed.provider,
        live: isLive,
        rejected
      });
      return { status: 502, body: { error: 'AI returned no usable drafts.', rejected, provider: routed.provider } };
    }

    if (!isLive) {
      await logActivity(env.SUPABASE_URL, sbHeaders, `Outreach Writer dry run via ${providerLabel(routed.provider)} — ${accepted.length} draft(s) validated; nothing written.`, {
        live: false,
        provider: routed.provider,
        model: routed.model,
        fallback_used: routed.fallback_used,
        companies: accepted.map(d => d.company_name),
        rejected
      });
      return {
        status: 200,
        body: {
          mode: 'DRY RUN — no drafts were written. Add &live=true to insert.',
          provider: routed.provider,
          model: routed.model,
          fallback_used: routed.fallback_used,
          drafted: accepted.length,
          results: accepted,
          rejected
        }
      };
    }

    let inserted = 0;
    const results = [];
    const failures = [];

    for (const draft of accepted) {
      const insert = await fetch(`${env.SUPABASE_URL}/rest/v1/email_drafts`, {
        method: 'POST',
        headers: { ...sbHeaders, Prefer: 'return=representation' },
        body: JSON.stringify({
          prospect_id: draft.prospect_id,
          subject: draft.subject,
          body: draft.body,
          status: 'draft'
        })
      });

      if (!insert.ok) {
        failures.push({ company_name: draft.company_name, stage: 'draft_insert', status: insert.status, error: clip(await insert.text(), 800) });
        continue;
      }

      const update = await fetch(`${env.SUPABASE_URL}/rest/v1/prospects?id=eq.${encodeURIComponent(draft.prospect_id)}`, {
        method: 'PATCH',
        headers: { ...sbHeaders, Prefer: 'return=minimal' },
        body: JSON.stringify({ status: 'draft_ready', updated_at: new Date().toISOString() })
      });

      if (!update.ok) {
        failures.push({ company_name: draft.company_name, stage: 'prospect_status', status: update.status, error: clip(await update.text(), 800) });
      }

      inserted += 1;
      results.push({
        company_name: draft.company_name,
        prospect_id: draft.prospect_id,
        recipient_email: draft.recipient_email,
        subject: draft.subject
      });
    }

    await logActivity(
      env.SUPABASE_URL,
      sbHeaders,
      `Outreach Writer complete via ${providerLabel(routed.provider)} — created ${inserted} personalized draft(s); ${failures.length} failure(s). Human approval still required.`,
      {
        live: true,
        provider: routed.provider,
        model: routed.model,
        fallback_used: routed.fallback_used,
        results,
        failures,
        rejected
      }
    );

    return {
      status: 200,
      body: {
        mode: 'LIVE — drafts were written to email_drafts. Nothing was sent.',
        provider: routed.provider,
        model: routed.model,
        fallback_used: routed.fallback_used,
        drafted: inserted,
        results,
        failures,
        rejected
      }
    };
  } catch (error) {
    const message = clip(error?.message || String(error), 1000);
    await logActivity(env.SUPABASE_URL, sbHeaders, 'Outreach Writer failed unexpectedly.', { error: message, live: isLive });
    return { status: 500, body: { error: message } };
  }
}

function buildPrompt(profile, targets) {
  const services = Array.isArray(profile?.services) ? profile.services.join(', ') : '';
  const ports = Array.isArray(profile?.ports_covered) ? profile.ports_covered.join(', ') : '';
  const approved = Array.isArray(profile?.approved_claims) ? profile.approved_claims.join('; ') : '';
  const forbidden = Array.isArray(profile?.forbidden_claims) ? profile.forbidden_claims.join('; ') : '';
  const signature = cleanString(profile?.signature, 2500) || 'Best regards,\nYachts Logistics';
  const partnership = cleanString(profile?.operational_partnership_model, 3000) || '';
  const controls = profile?.sending_limits && typeof profile.sending_limits === 'object' ? profile.sending_limits : {};
  const targetMarkets = Array.isArray(controls.target_markets) ? controls.target_markets.join(', ') : 'GCC, Iran, India, Pakistan, international';
  const routeNotes = cleanString(controls.outreach_route_notes, 3000) ||
    'Yachts Logistics provides shipping/logistics support from Shinas Port, Oman to Iran.';

  const prospectFacts = targets.map(t => ({
    prospect_id: String(t.id),
    company_name: t.company_name,
    country: t.country || null,
    business_type: t.business_type || null,
    oman_relevance_score: t.oman_relevance_score ?? null,
    relevance_reason: t.relevance_reason || null,
    website: t.website || null,
    source_links: Array.isArray(t.source_links) ? t.source_links : [],
    verified_contact_name: t.contact?.name || null,
    verified_contact_role: t.contact?.role || null,
    // email intentionally omitted from the model prompt; the worker owns routing.
    verification_source: t.contact?.verification_source || null
  }));

  return `
You write first-contact B2B outreach email DRAFTS for Yachts Logistics, Oman.

COMPANY FACTS:
Services: ${services || 'Use only the approved and prospect-specific facts supplied.'}
Ports covered: ${ports || 'Not supplied'}
Approved claims: ${approved || 'None separately supplied'}
Forbidden claims: ${forbidden || 'Never invent capabilities, licenses, clients, prices, guarantees, vessel history, or relationships.'}
Operational partnership model: ${partnership || 'For direct foreign prospects, focus on Oman vessel support. Do not invent a partnership arrangement unless the supplied facts justify it.'}
Priority markets: ${targetMarkets}
Approved route / market notes: ${routeNotes}
Required signature:
${signature}

RULES:
- Write a different email for each prospect, using ONLY the supplied facts.
- Never invent a person's name, vessel, route, client, port call, price, license,
  past job, relationship, or claim that the company definitely has an Oman call.
- If a named contact is supplied, you may greet that exact name. Otherwise use a
  neutral greeting; never make up a name.
- Keep each email concise, natural, professional, and useful.
- A safe phrasing is "if you have vessels or clients calling Oman" when relevant.
- For an Iran / freight-forwarding / cargo prospect, you may naturally mention the approved Shinas Port → Iran route note. Do not invent sailing dates, rates, cargo capacity, customs promises, or Iranian destinations.
- For shipowners, managers and vessel operators, choose only 1–3 relevant services from COMPANY FACTS. If vessel/engine repair or maintenance is not listed in Services or Approved claims, do NOT mention it.
- Do not dump every service into every email. Personalize the angle to the prospect type.
- Do not include fake urgency, fake attachments, or fake prior conversations.
- These are drafts only. Nothing is being sent.
- Return ONLY valid JSON. No markdown or commentary.

Return exactly one object per supplied prospect:
[
  {
    "prospect_id": "copy the exact prospect_id",
    "subject": "short subject",
    "body": "complete email body including the supplied signature"
  }
]

PROSPECTS:
${JSON.stringify(prospectFacts, null, 2)}
`.trim();
}

async function callRouter(env, payload) {
  try {
    const response = await fetch(`${String(env.AI_ROUTER_URL).replace(/\/+$/, '')}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-router-secret': env.ROUTER_SECRET },
      body: JSON.stringify(payload)
    });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch (_) { data = null; }
    if (!response.ok || !data?.ok) return { ok: false, status: response.status, error: data?.error || clip(text, 1000), data };
    return {
      ok: true,
      provider: data.provider,
      model: data.model,
      output: data.output || '',
      fallback_used: Boolean(data.fallback_used),
      usage: data.usage || null
    };
  } catch (error) {
    return { ok: false, status: 502, error: `Could not reach AI Router: ${error.message || String(error)}` };
  }
}

function parseDraftArray(rawText) {
  const cleaned = String(rawText || '').replace(/```json/gi, '').replace(/```/g, '').trim();
  const first = cleaned.indexOf('[');
  const last = cleaned.lastIndexOf(']');
  if (first < 0 || last <= first) return { ok: false, error: 'AI did not return a JSON array.' };
  try {
    const rows = JSON.parse(cleaned.slice(first, last + 1));
    return Array.isArray(rows) ? { ok: true, rows } : { ok: false, error: 'AI output was not an array.' };
  } catch (error) {
    return { ok: false, error: `Invalid JSON: ${error.message}` };
  }
}

async function fetchCompanyProfile(base, headers) {
  const response = await fetch(`${base}/rest/v1/company_profile?select=*&limit=1`, { headers });
  if (!response.ok) return {};
  const rows = await response.json();
  return rows?.[0] || {};
}

async function fetchCandidateProspects(base, headers, limit) {
  const url = new URL(`${base}/rest/v1/prospects`);
  url.searchParams.set('status', 'eq.researched');
  url.searchParams.set('oman_relevance_score', `gte.${MIN_PROSPECT_SCORE}`);
  url.searchParams.set('select', '*');
  url.searchParams.set('order', 'oman_relevance_score.desc,discovered_at.asc');
  url.searchParams.set('limit', String(limit));
  const response = await fetch(url.toString(), { headers });
  if (!response.ok) return { ok: false, error: clip(await response.text(), 1000) };
  return { ok: true, rows: await response.json() };
}

async function fetchVerifiedContacts(base, headers) {
  const url = new URL(`${base}/rest/v1/contacts`);
  url.searchParams.set('verified', 'eq.true');
  url.searchParams.set('select', '*');
  url.searchParams.set('limit', '1000');
  const response = await fetch(url.toString(), { headers });
  if (!response.ok) return { ok: false, error: clip(await response.text(), 1000) };
  return { ok: true, rows: await response.json() };
}

async function fetchExistingDraftProspectIds(base, headers) {
  const response = await fetch(`${base}/rest/v1/email_drafts?select=prospect_id&limit=2000`, { headers });
  if (!response.ok) return { ok: false, error: clip(await response.text(), 1000) };
  const rows = await response.json();
  return { ok: true, ids: new Set((rows || []).map(r => r.prospect_id).filter(Boolean)) };
}

async function logActivity(base, headers, action, detail) {
  try {
    await fetch(`${base}/rest/v1/activity_log`, {
      method: 'POST',
      headers: { ...headers, Prefer: 'return=minimal' },
      body: JSON.stringify({ worker_name: 'Outreach Writer', action, target_table: 'email_drafts', detail: detail || {} })
    });
  } catch (_) {}
}

function normalizeCompanyName(value) { return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
function cleanString(value, max) { return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null; }
function providerLabel(provider) { return provider === 'openai' ? 'OpenAI Luna' : provider === 'gemini' ? 'Gemini' : String(provider || 'AI Router'); }
function clip(value, max) { return String(value || '').slice(0, max); }
function jsonResponse(status, body) { return new Response(JSON.stringify(body, null, 2), { status, headers: { 'Content-Type': 'application/json' } }); }
