// Outreach Writer v1 — Cloudflare Worker for Yacht Logistics OS
//
// Purpose:
// - Reads high-fit researched prospects that already have a VERIFIED public
//   business email in contacts.
// - Reads the real company_profile / Settings.
// - Generates personalized DRAFTS only. It NEVER sends email.
// - Writes drafts to email_drafts with status="draft" for human review.
// - Moves the prospect to draft_ready only after a draft is stored.
// - Uses one Gemini request for a batch to conserve the free request budget.
//
// Required Cloudflare variables/secrets:
//   GEMINI_API_KEY          Secret
//   SUPABASE_URL            Plain text variable
//   SUPABASE_SERVICE_KEY    Secret
//   WORKER_SECRET           Secret
//
// Recommended Cron after one dry run + one live run succeed:
//   45 */6 * * *
// Four opportunities/day, but the worker self-caps to 2 actual Gemini calls
// per Oman calendar day. Empty runs cost no AI request.
//
// This worker deliberately does NOT send email.

const MODEL = 'gemini-flash-latest';
const DEFAULT_BATCH_SIZE = 5;
const MAX_BATCH_SIZE = 10;
const MIN_PROSPECT_SCORE = 70;

// Relevance Scorer currently protects itself at 14 calls/day.
// Keep Outreach Writer to max 2 real calls/day and also stop if the combined
// Scorer + Writer activity reaches 16, preserving headroom for manual tests.
const MAX_WRITER_CALLS_PER_DAY = 2;
const MAX_COMBINED_GEMINI_CALLS_PER_DAY = 16;
const GEMINI_WORKER_NAMES = ['Relevance Scorer', 'Outreach Writer'];

// Known oversized/state-owned targets already excluded from the intended funnel.
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
    const requestedBatch = Number.parseInt(
      url.searchParams.get('batch') || String(DEFAULT_BATCH_SIZE),
      10
    );
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
  const { GEMINI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY } = env;

  if (!GEMINI_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return {
      status: 500,
      body: { error: 'Missing one of GEMINI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY.' }
    };
  }

  const sbHeaders = {
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json'
  };

  try {
    const usage = await countGeminiCallsToday(SUPABASE_URL, sbHeaders);

    if (!usage.ok) {
      const reason = `Could not verify Gemini usage safely: ${usage.error}`;
      await logActivity(SUPABASE_URL, sbHeaders, `Skipped — ${reason}`, { live: isLive });
      return { status: 500, body: { error: reason } };
    }

    if (usage.writer >= MAX_WRITER_CALLS_PER_DAY) {
      const reason = `Outreach Writer daily Gemini budget protected (${usage.writer}/${MAX_WRITER_CALLS_PER_DAY} writer calls used today).`;
      await logActivity(SUPABASE_URL, sbHeaders, `Skipped — ${reason}`, {
        live: isLive,
        gemini_calls_today: usage
      });
      return { status: 200, body: { skipped: true, reason } };
    }

    if (usage.combined >= MAX_COMBINED_GEMINI_CALLS_PER_DAY) {
      const reason = `Shared Gemini headroom protected (${usage.combined}/${MAX_COMBINED_GEMINI_CALLS_PER_DAY} Scorer + Writer calls counted today).`;
      await logActivity(SUPABASE_URL, sbHeaders, `Skipped — ${reason}`, {
        live: isLive,
        gemini_calls_today: usage
      });
      return { status: 200, body: { skipped: true, reason } };
    }

    const profile = await fetchCompanyProfile(SUPABASE_URL, sbHeaders);
    const prospects = await fetchCandidateProspects(SUPABASE_URL, sbHeaders, Math.max(50, batchSize * 10));
    if (!prospects.ok) {
      return { status: 500, body: { error: `Could not read prospects: ${prospects.error}` } };
    }

    const contacts = await fetchVerifiedContacts(SUPABASE_URL, sbHeaders);
    if (!contacts.ok) {
      return { status: 500, body: { error: `Could not read contacts: ${contacts.error}` } };
    }

    const drafts = await fetchExistingDraftProspectIds(SUPABASE_URL, sbHeaders);
    if (!drafts.ok) {
      return { status: 500, body: { error: `Could not read existing drafts: ${drafts.error}` } };
    }

    const bestContactByProspect = new Map();
    for (const contact of contacts.rows) {
      if (!contact.prospect_id || !contact.email) continue;
      if (!bestContactByProspect.has(contact.prospect_id)) {
        bestContactByProspect.set(contact.prospect_id, contact);
      }
    }

    const targets = prospects.rows
      .filter(p => !BLOCKED_NAMES.some(name => normalizeCompanyName(p.company_name).includes(name)))
      .filter(p => !drafts.ids.has(p.id))
      .filter(p => bestContactByProspect.has(p.id))
      .slice(0, batchSize)
      .map(p => ({ ...p, contact: bestContactByProspect.get(p.id) }));

    if (targets.length === 0) {
      const reason = `No researched prospects scoring ${MIN_PROSPECT_SCORE}+ with a verified business email are waiting for a first draft.`;
      await logActivity(SUPABASE_URL, sbHeaders, `Skipped — ${reason}`, {
        live: isLive,
        gemini_calls_today: usage
      });
      return { status: 200, body: { drafted: 0, reason } };
    }

    const prompt = buildPrompt(profile, targets);
    const geminiResult = await callGemini(GEMINI_API_KEY, prompt);

    if (!geminiResult.ok) {
      await logActivity(
        SUPABASE_URL,
        sbHeaders,
        `Run failed — Gemini returned HTTP ${geminiResult.status}.`,
        {
          live: isLive,
          error: clip(geminiResult.error, 1000),
          target_companies: targets.map(t => t.company_name)
        }
      );
      return {
        status: 502,
        body: {
          error: `Gemini request failed with HTTP ${geminiResult.status}.`,
          detail: clip(geminiResult.error, 1000)
        }
      };
    }

    const parsed = parseDraftArray(geminiResult.text);
    if (!parsed.ok) {
      await logActivity(SUPABASE_URL, sbHeaders, 'Run failed — Gemini draft output was not valid JSON.', {
        live: isLive,
        error: parsed.error,
        response_excerpt: clip(geminiResult.text, 1000)
      });
      return { status: 502, body: { error: parsed.error } };
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
      accepted.push({
        prospect_id: target.id,
        company_name: target.company_name,
        recipient_email: target.contact.email,
        subject,
        body
      });
      seen.add(prospectId);
    }

    if (accepted.length === 0) {
      await logActivity(SUPABASE_URL, sbHeaders, 'Run failed — no usable drafts survived validation.', {
        live: isLive,
        rejected
      });
      return { status: 502, body: { error: 'Gemini returned no usable drafts.', rejected } };
    }

    if (!isLive) {
      await logActivity(SUPABASE_URL, sbHeaders, `Outreach Writer dry run complete — ${accepted.length} draft(s) validated, nothing written.`, {
        live: false,
        companies: accepted.map(d => d.company_name),
        rejected
      });
      return {
        status: 200,
        body: {
          mode: 'DRY RUN — no drafts were written. Add &live=true to insert.',
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
      const insert = await fetch(`${SUPABASE_URL}/rest/v1/email_drafts`, {
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
        failures.push({
          company_name: draft.company_name,
          stage: 'draft_insert',
          status: insert.status,
          error: clip(await insert.text(), 800)
        });
        continue;
      }

      const update = await fetch(
        `${SUPABASE_URL}/rest/v1/prospects?id=eq.${encodeURIComponent(draft.prospect_id)}`,
        {
          method: 'PATCH',
          headers: { ...sbHeaders, Prefer: 'return=minimal' },
          body: JSON.stringify({ status: 'draft_ready' })
        }
      );

      if (!update.ok) {
        failures.push({
          company_name: draft.company_name,
          stage: 'prospect_status',
          status: update.status,
          error: clip(await update.text(), 800)
        });
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
      SUPABASE_URL,
      sbHeaders,
      `Outreach Writer complete — created ${inserted} personalized draft(s); ${failures.length} failure(s). Human approval still required.`,
      {
        live: true,
        model: MODEL,
        results,
        failures,
        rejected
      }
    );

    return {
      status: 200,
      body: {
        mode: 'LIVE — drafts were written to email_drafts. Nothing was sent.',
        drafted: inserted,
        results,
        failures,
        rejected
      }
    };
  } catch (error) {
    const message = clip(error?.message || String(error), 1000);
    await logActivity(SUPABASE_URL, sbHeaders, 'Outreach Writer failed unexpectedly.', {
      error: message,
      live: isLive
    });
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

  const prospectFacts = targets.map(t => ({
    prospect_id: String(t.id),
    company_name: t.company_name,
    country: t.country || null,
    business_type: t.business_type || null,
    oman_relevance_score: t.oman_relevance_score ?? null,
    relevance_reason: t.relevance_reason || null,
    website: t.website || null,
    source_links: t.source_links || [],
    verified_contact_name: t.contact?.name || null,
    verified_contact_role: t.contact?.role || null,
    verified_business_email: t.contact?.email || null,
    verification_source: t.contact?.verification_source || null
  }));

  return `
You write first-contact B2B outreach emails for Yachts Logistics, Oman.

COMPANY FACTS:
Services: ${services || 'Use only the prospect-specific and approved facts supplied.'}
Ports covered: ${ports || 'Not supplied'}
Approved claims: ${approved || 'None separately supplied'}
Forbidden claims: ${forbidden || 'Never invent capabilities, licenses, clients, prices, guarantees, vessel history, or relationships.'}
Operational partnership model: ${partnership || 'For direct foreign prospects, focus on Oman vessel support. Do not invent a partnership arrangement unless the supplied prospect facts justify it.'}
Required signature:
${signature}

SAFETY / QUALITY RULES:
- Write a DIFFERENT email for each company, based only on the supplied facts.
- Never invent a person's name, vessel, route, client, port call, price, license, past job, or relationship.
- Do not claim we know they have an Oman call unless the supplied evidence says so.
- Keep it professional, concise, natural, and specific.
- Mention Oman relevance in a cautious way (for example, "if you have vessels calling Oman").
- Do not include fake urgency.
- Do not include attachments.
- Do not send anything. These are drafts for human approval.
- Return ONLY valid JSON. No markdown.

For each prospect below, return exactly one object:
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

async function callGemini(apiKey, prompt) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.35 }
      })
    }
  );

  const text = await response.text();
  if (!response.ok) {
    return { ok: false, status: response.status, error: text };
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch (_) {
    return { ok: false, status: 502, error: 'Gemini returned non-JSON API response.' };
  }

  const output = data?.candidates?.[0]?.content?.parts?.map(p => p?.text || '').join('') || '';
  return { ok: true, status: response.status, text: output };
}

function parseDraftArray(rawText) {
  const cleaned = String(rawText || '')
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();

  const first = cleaned.indexOf('[');
  const last = cleaned.lastIndexOf(']');
  if (first < 0 || last <= first) {
    return { ok: false, error: 'Gemini did not return a JSON array.' };
  }

  try {
    const rows = JSON.parse(cleaned.slice(first, last + 1));
    if (!Array.isArray(rows)) return { ok: false, error: 'Gemini output was not an array.' };
    return { ok: true, rows };
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

async function countGeminiCallsToday(base, headers) {
  const start = getOmanDayStartISO();
  const url = new URL(`${base}/rest/v1/activity_log`);
  url.searchParams.set(
    'worker_name',
    `in.(${GEMINI_WORKER_NAMES.map(name => `\"${name}\"`).join(',')})`
  );
  url.searchParams.set('created_at', `gte.${start}`);
  url.searchParams.set('action', 'not.ilike.*Skipped*');
  url.searchParams.set('select', 'worker_name');
  url.searchParams.set('limit', '1000');

  const response = await fetch(url.toString(), { headers });
  if (!response.ok) {
    return { ok: false, error: clip(await response.text(), 800), combined: 0, writer: 0 };
  }

  const rows = await response.json();
  return {
    ok: true,
    combined: (rows || []).length,
    writer: (rows || []).filter(r => r.worker_name === 'Outreach Writer').length
  };
}

function getOmanDayStartISO() {
  const now = new Date();
  const omanNow = new Date(now.getTime() + 4 * 60 * 60 * 1000);
  const omanMidnightAsUTCFields = Date.UTC(
    omanNow.getUTCFullYear(),
    omanNow.getUTCMonth(),
    omanNow.getUTCDate(),
    0, 0, 0
  );
  return new Date(omanMidnightAsUTCFields - 4 * 60 * 60 * 1000).toISOString();
}

async function logActivity(base, headers, action, detail) {
  try {
    await fetch(`${base}/rest/v1/activity_log`, {
      method: 'POST',
      headers: { ...headers, Prefer: 'return=minimal' },
      body: JSON.stringify({
        worker_name: 'Outreach Writer',
        action,
        target_table: 'email_drafts',
        detail: detail || {}
      })
    });
  } catch (_) {
    // Never let logging break the run.
  }
}

function normalizeCompanyName(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function cleanString(value, maxLength) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text ? text.slice(0, maxLength) : null;
}

function clip(value, maxLength) {
  return String(value || '').slice(0, maxLength);
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}
