// Contact Finder v4 — Cloudflare Worker for Yacht Logistics OS
//
// What changed from v3, and why:
//
// v3 required the contact's exact name/email to appear as a literal
// substring inside Groq's raw search-tool JSON. That bar turned out to be
// almost impossible to pass — the console showed it failing on essentially
// every real attempt ("found 0, failed or unverified 1, out of 1"), not
// because nothing was found, but because the check itself was too strict.
//
// This version verifies evidence the same proven way Prospect Finder does:
// the claimed source URL's website must match a real website that Groq's
// search actually returned. Same safety guarantee (no invented contacts),
// much more realistic bar to clear.
//
// Also restored batch size to 3 (v3 had it hardcoded to 1), since the
// shared Groq budget tracking already accounts for this safely.
//
// Required Cloudflare variables/secrets (unchanged):
//   GROQ_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY, WORKER_SECRET
//
// Cron stays as-is: 30 */3 * * * (30 min after Prospect Finder, every 3 hrs)

const MODEL = 'groq/compound-mini';
const DEFAULT_BATCH_SIZE = 3;
const MAX_BATCH_SIZE = 5;
const MIN_PROSPECT_SCORE = 70;

const SAFE_DAILY_GROQ_REQUEST_BUDGET = 18;
const SAFE_DAILY_GROQ_TOKEN_BUDGET = 70000;
const ESTIMATED_GROQ_TOKENS_PER_REQUEST = 7000;
const GROQ_WORKER_NAMES = ['Prospect Finder', 'Contact Finder'];

export default {
  async fetch(request, env) {
    const providedSecret = request.headers.get('x-worker-secret');
    if (!env.WORKER_SECRET || providedSecret !== env.WORKER_SECRET) {
      return jsonResponse(401, { error: 'Missing or incorrect x-worker-secret header.' });
    }

    const url = new URL(request.url);
    const requestedBatch = Number.parseInt(url.searchParams.get('batch') || String(DEFAULT_BATCH_SIZE), 10);
    const batchSize = Number.isFinite(requestedBatch) ? Math.max(1, Math.min(requestedBatch, MAX_BATCH_SIZE)) : DEFAULT_BATCH_SIZE;
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

  let groqRequests = 0;
  let totalTokens = 0;

  if (!GROQ_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return { status: 500, body: { error: 'Missing one of GROQ_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY.' } };
  }

  const sbHeaders = {
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json'
  };

  try {
    const usage = await readSharedGroqUsageLast24Hours(SUPABASE_URL, sbHeaders);

    if (!usage.ok) {
      await logActivity(SUPABASE_URL, sbHeaders, 'Skipped — could not verify shared Groq usage safely.', { error: usage.error, live: isLive, groq_requests: 0, tokens_used: 0 });
      return { status: 500, body: { error: `Could not verify recent Groq usage: ${usage.error}` } };
    }

    const projectedRequests = usage.requests + batchSize;
    const projectedTokens = usage.tokens + batchSize * ESTIMATED_GROQ_TOKENS_PER_REQUEST;

    if (projectedRequests > SAFE_DAILY_GROQ_REQUEST_BUDGET || projectedTokens > SAFE_DAILY_GROQ_TOKEN_BUDGET) {
      const reason = projectedRequests > SAFE_DAILY_GROQ_REQUEST_BUDGET
        ? `Shared Groq request budget protected (${usage.requests}/${SAFE_DAILY_GROQ_REQUEST_BUDGET} counted in the last 24 hours).`
        : `Shared Groq token budget protected (${usage.tokens} already counted or conservatively estimated; the next request could exceed ${SAFE_DAILY_GROQ_TOKEN_BUDGET}).`;

      await logActivity(SUPABASE_URL, sbHeaders, `Skipped — ${reason}`, { live: isLive, groq_requests: 0, tokens_used: 0, shared_usage_before: usage });
      return { status: 200, body: { skipped: true, reason } };
    }

    const existingContactIds = await fetchExistingContactProspectIds(SUPABASE_URL, sbHeaders);
    if (!existingContactIds.ok) {
      return { status: 500, body: { error: `Could not read existing contacts: ${existingContactIds.error}` } };
    }

    const researched = await fetchHighFitProspects(SUPABASE_URL, sbHeaders, Math.max(50, batchSize * 10));
    if (!researched.ok) {
      return { status: 500, body: { error: `Could not read prospects: ${researched.error}` } };
    }

    const targets = researched.rows.filter(p => !existingContactIds.ids.has(p.id)).slice(0, batchSize);

    if (targets.length === 0) {
      const reason = `No researched prospects scoring ${MIN_PROSPECT_SCORE}+ are waiting for a contact.`;
      await logActivity(SUPABASE_URL, sbHeaders, `Contact search complete — ${reason}`, { live: isLive, groq_requests: 0, tokens_used: 0, results: [] });
      return { status: 200, body: { found: 0, reason } };
    }

    let found = 0;
    const results = [];
    const failures = [];

    for (const prospect of targets) {
      if (usage.requests + groqRequests + 1 > SAFE_DAILY_GROQ_REQUEST_BUDGET ||
          usage.tokens + totalTokens + ESTIMATED_GROQ_TOKENS_PER_REQUEST > SAFE_DAILY_GROQ_TOKEN_BUDGET) {
        failures.push({ company_name: prospect.company_name, stage: 'budget', error: 'Stopped before this company to preserve the shared Groq budget.' });
        break;
      }

      let groqResponse;
      try {
        groqResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${GROQ_API_KEY}` },
          body: JSON.stringify({
            model: MODEL,
            messages: [{ role: 'user', content: buildContactPrompt(prospect) }],
            compound_custom: { tools: { enabled_tools: ['web_search'] } }
          })
        });
        groqRequests += 1;
      } catch (error) {
        failures.push({ company_name: prospect.company_name, stage: 'groq_network', error: clip(error.message || String(error), 500) });
        continue;
      }

      if (!groqResponse.ok) {
        failures.push({ company_name: prospect.company_name, stage: 'groq_api', status: groqResponse.status, retry_after: groqResponse.headers.get('retry-after'), error: clip(await groqResponse.text(), 800) });
        continue;
      }

      let groqData;
      try {
        groqData = await groqResponse.json();
      } catch (error) {
        failures.push({ company_name: prospect.company_name, stage: 'groq_response', error: `Groq returned a non-JSON response: ${clip(error.message || String(error), 500)}` });
        continue;
      }

      totalTokens += Number(groqData?.usage?.total_tokens) || 0;

      const message = groqData?.choices?.[0]?.message;
      const rawText = message?.content || '';
      const executedTools = Array.isArray(message?.executed_tools) ? message.executed_tools : [];

      const parsedResult = parseContactJson(rawText);
      if (!parsedResult.ok) {
        failures.push({ company_name: prospect.company_name, stage: 'parse', error: parsedResult.error, response_excerpt: clip(rawText, 500) });
        continue;
      }

      // --- Evidence check: does the claimed source's WEBSITE match a real
      // website Groq's search actually returned? Same standard already
      // proven to work in Prospect Finder — not a literal text match. ---
      const groundedHosts = extractHttpUrls(JSON.stringify(executedTools)).map(safeHostname).filter(Boolean);
      const contact = parsedResult.contact;

      if (!contact.source_url) {
        failures.push({ company_name: prospect.company_name, stage: 'evidence', error: 'No source URL was returned.' });
        continue;
      }
      if (!contact.email && !contact.name) {
        failures.push({ company_name: prospect.company_name, stage: 'evidence', error: 'No contact name or email was returned.' });
        continue;
      }
      if (groundedHosts.length === 0) {
        failures.push({ company_name: prospect.company_name, stage: 'evidence', error: 'Groq returned no web-search results at all for this query.' });
        continue;
      }
      if (!isGroundedUrl(contact.source_url, groundedHosts)) {
        failures.push({ company_name: prospect.company_name, stage: 'evidence', error: 'The claimed source website did not match any real search result.' });
        continue;
      }

      const record = {
        prospect_id: prospect.id,
        name: contact.name,
        role: contact.role,
        email: contact.email,
        verified: true,
        verification_source: contact.source_url
      };

      if (isLive) {
        const insertResponse = await fetch(`${SUPABASE_URL}/rest/v1/contacts`, {
          method: 'POST',
          headers: { ...sbHeaders, Prefer: 'return=minimal' },
          body: JSON.stringify(record)
        });
        if (!insertResponse.ok) {
          failures.push({ company_name: prospect.company_name, stage: 'supabase_insert', status: insertResponse.status, error: clip(await insertResponse.text(), 800) });
          continue;
        }
      }

      found += 1;
      results.push({ company_name: prospect.company_name, score: prospect.oman_relevance_score, name: record.name, role: record.role, email: record.email, verification_source: record.verification_source });
    }

    await logActivity(
      SUPABASE_URL, sbHeaders,
      `Contact search complete (${isLive ? 'live' : 'dry run'}) — found ${found}, failed or unverified ${failures.length}, out of ${targets.length} checked.`,
      { live: isLive, groq_requests: groqRequests, tokens_used: totalTokens, shared_usage_before: usage, results, failures }
    );

    return {
      status: 200,
      body: {
        mode: isLive ? 'LIVE — verified contacts were written to the database.' : 'DRY RUN — no contacts were written. Add &live=true to insert.',
        checked: targets.length,
        found,
        failed_or_unverified: failures.length,
        groq_requests: groqRequests,
        tokens_used: totalTokens,
        results,
        failures
      }
    };
  } catch (error) {
    const message = clip(error.message || String(error), 800);
    await logActivity(SUPABASE_URL, sbHeaders, 'Contact Finder failed unexpectedly.', { error: message, live: isLive, groq_requests: groqRequests, tokens_used: totalTokens });
    return { status: 500, body: { error: message } };
  }
}

function buildContactPrompt(prospect) {
  const sourceLinks = Array.isArray(prospect.source_links) ? prospect.source_links.join(', ') : prospect.source_links || 'none supplied';
  return `
Find one REAL, publicly listed business contact for the exact company below.

Priority order:
1. A publicly listed operations, agency, chartering, commercial, procurement, or management decision-maker WITH a business email.
2. A publicly listed named decision-maker even if no email is shown.
3. A general company enquiries, operations, agency, or commercial email.

Rules:
- Search the web. Do not rely on memory.
- Never infer an email pattern and never invent a name, role, or email.
- Prefer the company's official website. A reputable business directory is acceptable only when the exact contact information is visibly listed.
- If evidence is missing, return nulls.

Company name: ${prospect.company_name}
Country: ${prospect.country || 'unknown'}
Business type: ${prospect.business_type || 'unknown'}
Known website: ${prospect.website || 'unknown'}
Existing evidence links: ${sourceLinks}

Respond with ONLY one JSON object:
{
  "name": "publicly listed name or null",
  "role": "publicly listed role or null",
  "email": "publicly listed business email or null",
  "source_url": "the supporting http/https URL or null"
}

If no verifiable name or email is found, return exactly:
{"name":null,"role":null,"email":null,"source_url":null}
`.trim();
}

async function fetchExistingContactProspectIds(SUPABASE_URL, headers) {
  const url = new URL(`${SUPABASE_URL}/rest/v1/contacts`);
  url.searchParams.set('select', 'prospect_id');
  url.searchParams.set('limit', '1000');
  const response = await fetch(url.toString(), { headers });
  if (!response.ok) return { ok: false, error: clip(await response.text(), 800) };
  const rows = await response.json();
  return { ok: true, ids: new Set((rows || []).map(r => r.prospect_id).filter(Boolean)) };
}

async function fetchHighFitProspects(SUPABASE_URL, headers, limit) {
  const url = new URL(`${SUPABASE_URL}/rest/v1/prospects`);
  url.searchParams.set('status', 'eq.researched');
  url.searchParams.set('oman_relevance_score', `gte.${MIN_PROSPECT_SCORE}`);
  url.searchParams.set('select', 'id,company_name,country,business_type,website,source_links,relevance_reason,oman_relevance_score');
  url.searchParams.set('order', 'oman_relevance_score.desc,discovered_at.asc');
  url.searchParams.set('limit', String(limit));
  const response = await fetch(url.toString(), { headers });
  if (!response.ok) return { ok: false, error: clip(await response.text(), 800) };
  return { ok: true, rows: await response.json() };
}

async function readSharedGroqUsageLast24Hours(SUPABASE_URL, headers) {
  const windowStart = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const url = new URL(`${SUPABASE_URL}/rest/v1/activity_log`);
  url.searchParams.set('worker_name', `in.(${GROQ_WORKER_NAMES.map(n => `"${n}"`).join(',')})`);
  url.searchParams.set('created_at', `gte.${windowStart}`);
  url.searchParams.set('select', 'worker_name,action,detail');
  url.searchParams.set('limit', '1000');

  const response = await fetch(url.toString(), { headers });
  if (!response.ok) return { ok: false, error: clip(await response.text(), 800) };

  const rows = await response.json();
  let requests = 0;
  let tokens = 0;
  let estimatedTokenRows = 0;

  for (const row of rows || []) {
    const detail = row?.detail && typeof row.detail === 'object' ? row.detail : {};
    const action = String(row?.action || '').toLowerCase();
    const failuresArr = Array.isArray(detail.failures) ? detail.failures : [];
    const rejectedInFailureDetail = failuresArr.some(f => f?.stage === 'groq_api' && (Number(f?.status) === 429 || Number(f?.status) === 413));
    const rejectedBeforeGeneration = action.includes('http 429') || action.includes('http 413') || action.startsWith('skipped') || rejectedInFailureDetail;

    const explicitRequests = Number(detail.groq_requests);
    if (Number.isFinite(explicitRequests) && explicitRequests >= 0) {
      requests += explicitRequests;
    } else if (row.worker_name === 'Prospect Finder' && !rejectedBeforeGeneration) {
      requests += 1;
    }

    const rowTokens = Number(detail.tokens_used);
    if (Number.isFinite(rowTokens) && rowTokens > 0) {
      tokens += rowTokens;
    } else if (Number.isFinite(explicitRequests) && explicitRequests > 0 && !rejectedBeforeGeneration) {
      tokens += explicitRequests * ESTIMATED_GROQ_TOKENS_PER_REQUEST;
      estimatedTokenRows += 1;
    } else if (row.worker_name === 'Prospect Finder' && !rejectedBeforeGeneration) {
      tokens += ESTIMATED_GROQ_TOKENS_PER_REQUEST;
      estimatedTokenRows += 1;
    }
  }

  return { ok: true, requests, tokens, rows_counted: (rows || []).length, estimated_token_rows: estimatedTokenRows };
}

function parseContactJson(rawText) {
  const cleaned = String(rawText || '').replace(/```json/gi, '').replace(/```/g, '').trim();
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace < 0 || lastBrace <= firstBrace) return { ok: false, error: 'Groq did not return a JSON object.' };

  let parsed;
  try {
    parsed = JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
  } catch (error) {
    return { ok: false, error: `Invalid JSON: ${error.message}` };
  }

  return {
    ok: true,
    contact: {
      name: cleanOptionalString(parsed.name, 160),
      role: cleanOptionalString(parsed.role, 160),
      email: normalizeEmail(parsed.email),
      source_url: normalizeHttpUrl(parsed.source_url)
    }
  };
}

function normalizeEmail(value) {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  if (!email || email === 'null') return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email.slice(0, 320) : null;
}

function normalizeHttpUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value.trim());
    return (url.protocol === 'http:' || url.protocol === 'https:') ? url.toString().slice(0, 2000) : null;
  } catch (_e) { return null; }
}

function cleanOptionalString(value, maxLength) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return (!text || text.toLowerCase() === 'null') ? null : text.slice(0, maxLength);
}

function extractHttpUrls(text) {
  return String(text || '').match(/https?:\/\/[^\s"'\\]+/g) || [];
}

function safeHostname(rawUrl) {
  try { return new URL(rawUrl).hostname.replace(/^www\./, '').toLowerCase(); }
  catch (_e) { return null; }
}

function isGroundedUrl(rawUrl, groundedHosts) {
  const claimedHost = safeHostname(rawUrl);
  return Boolean(claimedHost && groundedHosts.some(h => h === claimedHost || h.endsWith(`.${claimedHost}`) || claimedHost.endsWith(`.${h}`)));
}

async function logActivity(SUPABASE_URL, headers, action, detail) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/activity_log`, {
      method: 'POST',
      headers: { ...headers, Prefer: 'return=minimal' },
      body: JSON.stringify({ worker_name: 'Contact Finder', action, target_table: 'contacts', detail: detail || {} })
    });
  } catch (_e) { /* never let logging break the run */ }
}

function clip(value, maxLength) { return String(value || '').slice(0, maxLength); }

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body, null, 2), { status, headers: { 'Content-Type': 'application/json' } });
}