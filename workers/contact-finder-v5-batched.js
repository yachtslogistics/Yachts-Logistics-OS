// Yachts Logistics OS — Contact Finder v5.0 (batched)
//
// Purpose: turn the researched-prospect backlog into verified contacts faster.
// v4 made one Groq request per company. v5 asks Groq to research several companies
// in ONE Compound web-search request, while keeping the same reasonable host-based
// grounding rule that made v4 work.
//
// Broad-contact policy: any real, publicly listed business email is useful.
// Prefer operations/commercial/management contacts, but general/company/webmaster
// inboxes are allowed when they are the public contact Groq can actually ground.
//
// Required variables/secrets:
//   GROQ_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY, WORKER_SECRET
//
// Existing Cron can stay: 30 */3 * * *

const MODEL = 'groq/compound-mini';
const DEFAULT_BATCH_SIZE = 5;
const MAX_BATCH_SIZE = 6;
const MIN_PROSPECT_SCORE = 70;

const SAFE_DAILY_GROQ_REQUEST_BUDGET = 18;
const SAFE_DAILY_GROQ_TOKEN_BUDGET = 70000;
const ESTIMATED_TOKENS_PER_BATCH_REQUEST = 12000;
const GROQ_WORKER_NAMES = ['Prospect Finder', 'Contact Finder'];

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
    const result = await runContactFinder(env, batchSize, isLive);
    return jsonResponse(result.status, result.body);
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runContactFinder(env, DEFAULT_BATCH_SIZE, true));
  }
};

async function runContactFinder(env, batchSize, isLive) {
  const { GROQ_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY } = env;
  if (!GROQ_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return { status: 500, body: { error: 'Missing one of GROQ_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY.' } };
  }

  const sbHeaders = {
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json'
  };

  let groqRequests = 0;
  let totalTokens = 0;

  try {
    const usage = await readSharedGroqUsageLast24Hours(SUPABASE_URL, sbHeaders);
    if (!usage.ok) {
      await logActivity(SUPABASE_URL, sbHeaders, 'Skipped — could not verify shared Groq usage safely.', {
        error: usage.error, live: isLive, groq_requests: 0, tokens_used: 0
      });
      return { status: 500, body: { error: `Could not verify recent Groq usage: ${usage.error}` } };
    }

    const projectedRequests = usage.requests + 1;
    const projectedTokens = usage.tokens + ESTIMATED_TOKENS_PER_BATCH_REQUEST;
    if (projectedRequests > SAFE_DAILY_GROQ_REQUEST_BUDGET || projectedTokens > SAFE_DAILY_GROQ_TOKEN_BUDGET) {
      const reason = projectedRequests > SAFE_DAILY_GROQ_REQUEST_BUDGET
        ? `Shared Groq request budget protected (${usage.requests}/${SAFE_DAILY_GROQ_REQUEST_BUDGET} counted in the last 24 hours).`
        : `Shared Groq token budget protected (${usage.tokens} already counted or estimated; a batched contact request is conservatively reserved at ${ESTIMATED_TOKENS_PER_BATCH_REQUEST} tokens).`;
      await logActivity(SUPABASE_URL, sbHeaders, `Skipped — ${reason}`, {
        live: isLive, groq_requests: 0, tokens_used: 0, shared_usage_before: usage
      });
      return { status: 200, body: { skipped: true, reason } };
    }

    const existing = await fetchExistingContactProspectIds(SUPABASE_URL, sbHeaders);
    if (!existing.ok) return { status: 500, body: { error: `Could not read existing contacts: ${existing.error}` } };

    const researched = await fetchHighFitProspects(SUPABASE_URL, sbHeaders, Math.max(80, batchSize * 20));
    if (!researched.ok) return { status: 500, body: { error: `Could not read prospects: ${researched.error}` } };

    const targets = researched.rows.filter(p => !existing.ids.has(p.id)).slice(0, batchSize);
    if (!targets.length) {
      const reason = `No researched prospects scoring ${MIN_PROSPECT_SCORE}+ are waiting for a contact.`;
      await logActivity(SUPABASE_URL, sbHeaders, `Contact search complete — ${reason}`, {
        live: isLive, groq_requests: 0, tokens_used: 0, results: []
      });
      return { status: 200, body: { found: 0, reason } };
    }

    let response;
    try {
      response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${GROQ_API_KEY}` },
        body: JSON.stringify({
          model: MODEL,
          messages: [{ role: 'user', content: buildBatchPrompt(targets) }],
          compound_custom: { tools: { enabled_tools: ['web_search'] } }
        })
      });
      groqRequests = 1;
    } catch (error) {
      return failAndLog(SUPABASE_URL, sbHeaders, 502, 'Groq network error.', {
        live: isLive, error: clip(error?.message || error, 800), groq_requests: groqRequests, tokens_used: totalTokens
      });
    }

    if (!response.ok) {
      const text = clip(await response.text(), 1200);
      await logActivity(SUPABASE_URL, sbHeaders, `Contact Finder failed — Groq HTTP ${response.status}.`, {
        live: isLive, status: response.status, error: text, groq_requests: groqRequests, tokens_used: totalTokens
      });
      return { status: response.status === 429 ? 200 : 502, body: response.status === 429 ? { skipped: true, reason: text } : { error: text } };
    }

    const groqData = await response.json();
    totalTokens = Number(groqData?.usage?.total_tokens) || 0;
    const message = groqData?.choices?.[0]?.message || {};
    const rawText = message.content || '';
    const executedTools = Array.isArray(message.executed_tools) ? message.executed_tools : [];
    const groundedHosts = extractHttpUrls(JSON.stringify(executedTools)).map(safeHostname).filter(Boolean);

    const parsed = parseContactArray(rawText);
    if (!parsed.ok) {
      await logActivity(SUPABASE_URL, sbHeaders, 'Contact Finder failed — Groq output was not valid contact JSON.', {
        live: isLive, error: parsed.error, response_excerpt: clip(rawText, 1000), groq_requests: groqRequests, tokens_used: totalTokens
      });
      return { status: 502, body: { error: parsed.error, raw: clip(rawText, 1000) } };
    }

    const targetById = new Map(targets.map(t => [String(t.id), t]));
    const accepted = [];
    const failures = [];
    const seen = new Set();

    for (const item of parsed.rows) {
      const prospectId = cleanOptionalString(item.prospect_id, 120);
      if (!prospectId || !targetById.has(prospectId)) {
        failures.push({ prospect_id: prospectId, stage: 'validation', error: 'Unknown prospect_id returned by model.' });
        continue;
      }
      if (seen.has(prospectId)) continue;
      seen.add(prospectId);

      const target = targetById.get(prospectId);
      const contact = {
        name: cleanOptionalString(item.name, 160),
        role: cleanOptionalString(item.role, 160),
        email: normalizeEmail(item.email),
        source_url: normalizeHttpUrl(item.source_url)
      };

      if (!contact.source_url) {
        failures.push({ company_name: target.company_name, stage: 'evidence', error: 'No supporting source URL.' });
        continue;
      }
      if (!contact.email && !contact.name) {
        failures.push({ company_name: target.company_name, stage: 'evidence', error: 'No public name or business email found.' });
        continue;
      }
      if (!groundedHosts.length || !isGroundedUrl(contact.source_url, groundedHosts)) {
        failures.push({ company_name: target.company_name, stage: 'evidence', error: 'Claimed source website was not present in Groq web-search results.' });
        continue;
      }

      accepted.push({ target, contact });
    }

    // If Groq omitted a target entirely, record that clearly instead of silently hiding it.
    for (const target of targets) {
      if (!seen.has(String(target.id))) {
        failures.push({ company_name: target.company_name, stage: 'no_result', error: 'No contact object returned for this company.' });
      }
    }

    if (!isLive) {
      const results = accepted.map(({ target, contact }) => ({
        company_name: target.company_name,
        score: target.oman_relevance_score,
        name: contact.name,
        role: contact.role,
        email: contact.email,
        verification_source: contact.source_url
      }));
      await logActivity(SUPABASE_URL, sbHeaders,
        `Contact search complete (dry run) — found ${results.length}, failed or unverified ${failures.length}, out of ${targets.length} checked in one Groq request.`,
        { live: false, groq_requests: groqRequests, tokens_used: totalTokens, shared_usage_before: usage, results, failures }
      );
      return { status: 200, body: { mode: 'DRY RUN — no contacts were written.', checked: targets.length, found: results.length, failed_or_unverified: failures.length, groq_requests: groqRequests, tokens_used: totalTokens, results, failures } };
    }

    const results = [];
    for (const { target, contact } of accepted) {
      const record = {
        prospect_id: target.id,
        name: contact.name,
        role: contact.role,
        email: contact.email,
        verified: true,
        verification_source: contact.source_url
      };
      const insert = await fetch(`${SUPABASE_URL}/rest/v1/contacts`, {
        method: 'POST',
        headers: { ...sbHeaders, Prefer: 'return=minimal' },
        body: JSON.stringify(record)
      });
      if (!insert.ok) {
        failures.push({ company_name: target.company_name, stage: 'supabase_insert', status: insert.status, error: clip(await insert.text(), 800) });
        continue;
      }
      results.push({ company_name: target.company_name, score: target.oman_relevance_score, name: record.name, role: record.role, email: record.email, verification_source: record.verification_source });
    }

    await logActivity(SUPABASE_URL, sbHeaders,
      `Contact search complete (live) — found ${results.length}, failed or unverified ${failures.length}, out of ${targets.length} checked in one Groq request.`,
      { live: true, groq_requests: groqRequests, tokens_used: totalTokens, shared_usage_before: usage, results, failures }
    );

    return { status: 200, body: { mode: 'LIVE — verified contacts were written to the database.', checked: targets.length, found: results.length, failed_or_unverified: failures.length, groq_requests: groqRequests, tokens_used: totalTokens, results, failures } };
  } catch (error) {
    const message = clip(error?.message || String(error), 1000);
    await logActivity(SUPABASE_URL, sbHeaders, 'Contact Finder failed unexpectedly.', { error: message, live: isLive, groq_requests: groqRequests, tokens_used: totalTokens });
    return { status: 500, body: { error: message } };
  }
}

function buildBatchPrompt(targets) {
  const facts = targets.map(p => ({
    prospect_id: String(p.id),
    company_name: p.company_name,
    country: p.country || null,
    business_type: p.business_type || null,
    known_website: p.website || null,
    existing_evidence_links: Array.isArray(p.source_links) ? p.source_links : (p.source_links ? [p.source_links] : [])
  }));

  return `
Find ONE real, publicly listed business contact for EACH exact company below.
Use web search. Do not rely on memory.

CONTACT PRIORITY (preference only, NOT a strict rejection rule):
1. Named operations, agency, chartering, commercial, procurement, fleet, technical or management contact with a public business email.
2. Named business contact even if no email is visible.
3. Any real public company business inbox: operations, commercial, enquiries, info, contact, webmaster, etc.

IMPORTANT:
- We want broad reach. Do NOT reject a real public business email merely because it is general or not the ideal department.
- Never infer an email pattern and never invent a name, role or email.
- Prefer official company websites. A reputable directory is acceptable only when the contact is visibly listed.
- source_url must be the actual supporting http/https page found through web search.
- If no public name or email can be verified for a company, return nulls for that company.
- Return exactly one JSON object per prospect_id, in a single JSON array. No markdown or commentary.

FORMAT:
[
  {
    "prospect_id":"copy exact id",
    "name":"public name or null",
    "role":"public role or null",
    "email":"public business email or null",
    "source_url":"supporting URL or null"
  }
]

COMPANIES:
${JSON.stringify(facts, null, 2)}
`.trim();
}

async function fetchExistingContactProspectIds(base, headers) {
  const response = await fetch(`${base}/rest/v1/contacts?select=prospect_id&limit=2000`, { headers });
  if (!response.ok) return { ok: false, error: clip(await response.text(), 800) };
  const rows = await response.json();
  return { ok: true, ids: new Set((rows || []).map(r => r.prospect_id).filter(Boolean)) };
}

async function fetchHighFitProspects(base, headers, limit) {
  const url = new URL(`${base}/rest/v1/prospects`);
  url.searchParams.set('status', 'eq.researched');
  url.searchParams.set('oman_relevance_score', `gte.${MIN_PROSPECT_SCORE}`);
  url.searchParams.set('select', 'id,company_name,country,business_type,website,source_links,relevance_reason,oman_relevance_score');
  url.searchParams.set('order', 'oman_relevance_score.desc,discovered_at.asc');
  url.searchParams.set('limit', String(limit));
  const response = await fetch(url.toString(), { headers });
  if (!response.ok) return { ok: false, error: clip(await response.text(), 800) };
  return { ok: true, rows: await response.json() };
}

async function readSharedGroqUsageLast24Hours(base, headers) {
  const windowStart = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const url = new URL(`${base}/rest/v1/activity_log`);
  url.searchParams.set('worker_name', `in.(${GROQ_WORKER_NAMES.map(n => `"${n}"`).join(',')})`);
  url.searchParams.set('created_at', `gte.${windowStart}`);
  url.searchParams.set('select', 'worker_name,action,detail');
  url.searchParams.set('limit', '1000');
  const response = await fetch(url.toString(), { headers });
  if (!response.ok) return { ok: false, error: clip(await response.text(), 800) };
  const rows = await response.json();
  let requests = 0, tokens = 0, estimatedTokenRows = 0;
  for (const row of rows || []) {
    const detail = row?.detail && typeof row.detail === 'object' ? row.detail : {};
    const action = String(row?.action || '').toLowerCase();
    const failures = Array.isArray(detail.failures) ? detail.failures : [];
    const rejected = failures.some(f => f?.stage === 'groq_api' && [413,429].includes(Number(f?.status))) || action.includes('http 429') || action.includes('http 413') || action.startsWith('skipped');
    const explicit = Number(detail.groq_requests);
    if (Number.isFinite(explicit) && explicit >= 0) requests += explicit;
    else if (row.worker_name === 'Prospect Finder' && !rejected) requests += 1;

    const rowTokens = Number(detail.tokens_used);
    if (Number.isFinite(rowTokens) && rowTokens > 0) tokens += rowTokens;
    else if (Number.isFinite(explicit) && explicit > 0 && !rejected) { tokens += explicit * 7000; estimatedTokenRows++; }
    else if (row.worker_name === 'Prospect Finder' && !rejected) { tokens += 7000; estimatedTokenRows++; }
  }
  return { ok: true, requests, tokens, rows_counted: (rows || []).length, estimated_token_rows: estimatedTokenRows };
}

function parseContactArray(rawText) {
  const cleaned = String(rawText || '').replace(/```json/gi, '').replace(/```/g, '').trim();
  const first = cleaned.indexOf('['), last = cleaned.lastIndexOf(']');
  if (first < 0 || last <= first) return { ok: false, error: 'Groq did not return a JSON array.' };
  try {
    const rows = JSON.parse(cleaned.slice(first, last + 1));
    return Array.isArray(rows) ? { ok: true, rows } : { ok: false, error: 'Groq output was not an array.' };
  } catch (error) { return { ok: false, error: `Invalid JSON: ${error.message}` }; }
}

function normalizeEmail(value) {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  if (!email || email === 'null') return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email.slice(0, 320) : null;
}
function normalizeHttpUrl(value) {
  if (typeof value !== 'string') return null;
  try { const u = new URL(value.trim()); return ['http:','https:'].includes(u.protocol) ? u.toString().slice(0,2000) : null; } catch (_) { return null; }
}
function cleanOptionalString(value, max) { if (typeof value !== 'string') return null; const t=value.trim(); return (!t || t.toLowerCase()==='null') ? null : t.slice(0,max); }
function extractHttpUrls(text) { return String(text || '').match(/https?:\/\/[^\s"'\\]+/g) || []; }
function safeHostname(rawUrl) { try { return new URL(rawUrl).hostname.replace(/^www\./,'').toLowerCase(); } catch (_) { return null; } }
function isGroundedUrl(rawUrl, groundedHosts) { const h=safeHostname(rawUrl); return Boolean(h && groundedHosts.some(g => g===h || g.endsWith(`.${h}`) || h.endsWith(`.${g}`))); }
async function logActivity(base, headers, action, detail) { try { await fetch(`${base}/rest/v1/activity_log`, { method:'POST', headers:{...headers,Prefer:'return=minimal'}, body:JSON.stringify({worker_name:'Contact Finder',action,target_table:'contacts',detail:detail||{}}) }); } catch (_) {} }
async function failAndLog(base, headers, status, action, detail) { await logActivity(base, headers, action, detail); return { status, body: { error: detail?.error || action } }; }
function clip(value,max){ return String(value||'').slice(0,max); }
function jsonResponse(status,body){ return new Response(JSON.stringify(body,null,2),{status,headers:{'Content-Type':'application/json'}}); }
