// Prospect Finder v6 — market rotation for Yachts Logistics OS
//
// Keeps the proven v5 grounding style (real web-search host verification),
// duplicate protection, 413/429 lean retry, partner/prospect split, and shared
// Groq budget protection. Adds balanced geography rotation so research does not
// become Oman-only or GCC-only.
//
// Rotation: GCC -> Iran/Shinas corridor -> India/South Asia -> International.
// People are NOT invented here; Contact Finder handles public decision-makers.
//
// Required variables/secrets:
//   GROQ_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY, WORKER_SECRET

const SAFE_SHARED_GROQ_TOKEN_BUDGET = 70000;
const ESTIMATED_GROQ_TOKENS_PER_REQUEST = 7000;
const GROQ_WORKER_NAMES = ['Prospect Finder', 'Contact Finder'];

const BUSINESS_TYPES = [
  'Shipowner', 'Ship Manager', 'Vessel Operator', 'Charterer',
  'Shipbroker', 'Freight Forwarder', 'Offshore & Marine', 'Overseas Agent',
  'Trading & Cargo'
];

const MARKET_FOCUSES = [
  {
    name: 'GCC',
    instruction: 'Prioritize UAE, Saudi Arabia, Qatar, Bahrain and Kuwait. Look for companies with vessels, clients, cargo or agency relationships that may require Oman support.'
  },
  {
    name: 'Iran / Shinas-Iran corridor',
    instruction: 'Prioritize Iran. Look for freight forwarders, shipping/logistics companies, vessel interests, overseas agents, traders/cargo companies and maritime businesses that could use the Shinas Port, Oman to Iran route or other Oman marine/logistics support.'
  },
  {
    name: 'India & South Asia',
    instruction: 'Prioritize India and Pakistan, especially shipowners, managers, operators, charterers, brokers, freight forwarders and overseas agents with Gulf/Oman trade or vessel activity.'
  },
  {
    name: 'International',
    instruction: 'Search internationally for smaller and mid-sized shipowners, managers, vessel operators, charterers, brokers, freight forwarders and overseas agents whose vessels or clients may need Oman support. Do not concentrate on one country.'
  }
];

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
    const requestedLimit = Number.parseInt(url.searchParams.get('limit') || '5', 10);
    const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 15)) : 5;
    const isLive = url.searchParams.get('live') === 'true';

    const result = await runProspectFinder(env, limit, isLive);
    return jsonResponse(result.status, result.body);
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runProspectFinder(env, 5, true));
  }
};

async function runProspectFinder(env, limit, isLive) {
  try {
    const { GROQ_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY } = env;
    if (!GROQ_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
      return { status: 500, body: { error: 'Missing one of GROQ_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY.' } };
    }

    const sbHeaders = {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json'
    };

    const usage = await readSharedGroqUsageLast24Hours(SUPABASE_URL, sbHeaders);
    if (!usage.ok) {
      await logActivity(SUPABASE_URL, sbHeaders, 'Skipped — could not verify shared Groq usage safely.', { error: usage.error });
      return { status: 500, body: { error: `Could not verify recent Groq usage: ${usage.error}` } };
    }
    if (usage.tokens + ESTIMATED_GROQ_TOKENS_PER_REQUEST > SAFE_SHARED_GROQ_TOKEN_BUDGET) {
      const reason = `Shared Groq token budget protected (${usage.tokens} already counted or conservatively estimated; the next request could exceed ${SAFE_SHARED_GROQ_TOKEN_BUDGET}).`;
      await logActivity(SUPABASE_URL, sbHeaders, `Skipped — ${reason}`, { shared_usage_before: usage });
      return { status: 200, body: { skipped: true, reason } };
    }

    const existingNames = await fetchExistingCompanyNames(SUPABASE_URL, sbHeaders);
    const namesShownToGroq = existingNames.slice(0, 30);
    const companyProfile = await readCompanyProfile(SUPABASE_URL, sbHeaders);

    const threeHourSlot = Math.floor(Date.now() / (3 * 60 * 60 * 1000));
    const marketFocus = MARKET_FOCUSES[threeHourSlot % MARKET_FOCUSES.length];
    const focusType = BUSINESS_TYPES[threeHourSlot % BUSINESS_TYPES.length];

    const promptFull = buildPrompt(companyProfile, limit, focusType, marketFocus, namesShownToGroq, false);
    let groqData = await callGroq(GROQ_API_KEY, promptFull);

    if (groqData.status === 413) {
      const leanPrompt = buildPrompt(companyProfile, Math.min(limit, 2), focusType, marketFocus, namesShownToGroq.slice(0, 20), true);
      groqData = await callGroq(GROQ_API_KEY, leanPrompt);
    }

    if (groqData.status === 429) {
      await sleep(8000);
      const leanPrompt = buildPrompt(companyProfile, Math.min(limit, 2), focusType, marketFocus, namesShownToGroq.slice(0, 20), true);
      groqData = await callGroq(GROQ_API_KEY, leanPrompt);
    }

    if (!groqData.ok) {
      await logActivity(SUPABASE_URL, sbHeaders, `Run failed — Groq returned HTTP ${groqData.status}.`, {
        error: clip(groqData.errorText, 500), focus_type: focusType, market_focus: marketFocus.name
      });
      return { status: 502, body: { error: `Groq request failed: ${groqData.errorText}` } };
    }

    const message = groqData.json?.choices?.[0]?.message;
    const rawText = message?.content || '';
    const executedToolsRaw = JSON.stringify(message?.executed_tools || []);
    const groundedHosts = extractHttpUrls(executedToolsRaw).map(safeHostname).filter(Boolean);
    const searchQueries = [...executedToolsRaw.matchAll(/"query"\s*:\s*"([^"]+)"/g)].map(m => m[1]).slice(0, 5);

    let companies = [];
    try {
      const cleaned = rawText.replace(/```json/gi, '').replace(/```/g, '').trim();
      const first = cleaned.indexOf('[');
      const last = cleaned.lastIndexOf(']');
      if (first < 0 || last <= first) throw new Error('No JSON array found');
      companies = JSON.parse(cleaned.slice(first, last + 1));
    } catch (error) {
      await logActivity(SUPABASE_URL, sbHeaders, 'Run failed — Groq output was not valid JSON.', { raw_preview: clip(rawText, 500), market_focus: marketFocus.name });
      return { status: 502, body: { error: 'Could not parse Groq output as JSON.', raw: clip(rawText, 800) } };
    }

    if (!Array.isArray(companies)) {
      return { status: 502, body: { error: 'Groq returned valid JSON, but it was not an array.' } };
    }
    companies = companies.slice(0, limit);

    if (groundedHosts.length === 0) {
      await logActivity(SUPABASE_URL, sbHeaders, 'Run aborted — no real search results returned, refusing to insert unverified data.', {
        attempted: companies.length, focus_type: focusType, market_focus: marketFocus.name
      });
      return { status: 200, body: { inserted: 0, reason: 'No web search results present — nothing inserted for safety.' } };
    }

    let insertedProspects = 0;
    let insertedPartners = 0;
    let skippedDuplicate = 0;
    let skippedNoEvidence = 0;
    let skippedUnverifiedSource = 0;
    let skippedBlocked = 0;
    let insertErrors = 0;
    const insertedNames = [];
    const wouldInsert = [];
    const insertErrorDetails = [];

    for (const c of companies) {
      if (!c?.company_name || !c?.source_url) { skippedNoEvidence++; continue; }
      const normalizedName = normalizeCompanyName(c.company_name);
      if (!normalizedName) { skippedNoEvidence++; continue; }
      if (BLOCKED_NAMES.some(b => normalizedName.includes(b))) { skippedBlocked++; continue; }
      if (existingNames.includes(normalizedName)) { skippedDuplicate++; continue; }
      if (!isGroundedUrl(c.source_url, groundedHosts)) { skippedUnverifiedSource++; continue; }

      const verifiedWebsite = c.website && isGroundedUrl(c.website, groundedHosts) ? normalizeHttpUrl(c.website) : null;
      const targetTable = c.target_table === 'partner' ? 'partner' : 'prospect';
      const businessType = BUSINESS_TYPES.includes(c.business_type) ? c.business_type : 'Other';

      if (!isLive) {
        wouldInsert.push({ ...c, business_type: businessType, target_table: targetTable, website: verifiedWebsite });
        existingNames.push(normalizedName);
        continue;
      }

      let insertRes;
      if (targetTable === 'partner') {
        insertRes = await fetch(`${SUPABASE_URL}/rest/v1/partners`, {
          method: 'POST',
          headers: { ...sbHeaders, Prefer: 'return=minimal' },
          body: JSON.stringify({
            partner_name: cleanString(c.company_name, 250),
            arrangement_type: 'Sub-agency (pending discussion)',
            commission_terms: `${cleanString(c.relevance_reason, 1000) || ''} Source: ${normalizeHttpUrl(c.source_url) || c.source_url}`.trim(),
            status: 'discovered'
          })
        });
      } else {
        insertRes = await fetch(`${SUPABASE_URL}/rest/v1/prospects`, {
          method: 'POST',
          headers: { ...sbHeaders, Prefer: 'return=minimal' },
          body: JSON.stringify({
            company_name: cleanString(c.company_name, 250),
            country: cleanString(c.country, 120),
            website: verifiedWebsite,
            business_type: businessType,
            relevance_reason: cleanString(c.relevance_reason, 1200),
            source_links: [normalizeHttpUrl(c.source_url) || c.source_url],
            status: 'discovered'
          })
        });
      }

      if (insertRes.ok) {
        if (targetTable === 'partner') insertedPartners++; else insertedProspects++;
        insertedNames.push(`${c.company_name} (${targetTable})`);
        existingNames.push(normalizedName);
      } else {
        insertErrors++;
        insertErrorDetails.push({ company_name: c.company_name, error: clip(await insertRes.text(), 300) });
      }
    }

    if (!isLive) {
      return {
        status: 200,
        body: {
          mode: 'DRY RUN — nothing was written. Add &live=true to insert.',
          focus_type: focusType,
          market_focus: marketFocus.name,
          search_queries: searchQueries,
          found: companies.length,
          would_insert: wouldInsert.length,
          would_insert_details: wouldInsert,
          skipped_duplicate: skippedDuplicate,
          skipped_no_evidence: skippedNoEvidence,
          skipped_unverified_source: skippedUnverifiedSource,
          skipped_blocked: skippedBlocked
        }
      };
    }

    await logActivity(SUPABASE_URL, sbHeaders,
      `Run complete — market: ${marketFocus.name}; focus: ${focusType}. Found ${companies.length}, inserted ${insertedProspects} prospects + ${insertedPartners} partners, skipped ${skippedDuplicate} duplicates, ${skippedNoEvidence} without evidence, ${skippedUnverifiedSource} unverified, ${skippedBlocked} blocked, ${insertErrors} insert errors.`,
      {
        market_focus: marketFocus.name,
        focus_type: focusType,
        inserted_names: insertedNames,
        search_queries: searchQueries,
        insert_errors: insertErrorDetails,
        groq_requests: 1,
        tokens_used: groqData.tokensUsed || 0
      }
    );

    return {
      status: 200,
      body: {
        mode: 'LIVE — changes were written to the database.',
        market_focus: marketFocus.name,
        focus_type: focusType,
        search_queries: searchQueries,
        found: companies.length,
        inserted_prospects: insertedProspects,
        inserted_partners: insertedPartners,
        skipped_duplicate: skippedDuplicate,
        skipped_no_evidence: skippedNoEvidence,
        skipped_unverified_source: skippedUnverifiedSource,
        skipped_blocked: skippedBlocked,
        insert_errors: insertErrors,
        inserted_names: insertedNames,
        tokens_used: groqData.tokensUsed || 0
      }
    };
  } catch (error) {
    const message = clip(error?.message || String(error), 800);
    if (env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY) {
      await logActivity(env.SUPABASE_URL, {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json'
      }, 'Run failed unexpectedly.', { error: message });
    }
    return { status: 500, body: { error: message } };
  }
}

async function readCompanyProfile(base, headers) {
  const fallback = {
    context: 'Yachts Logistics, a marine and offshore logistics company based in Oman',
    targetMarkets: ['UAE','Saudi Arabia','Qatar','Bahrain','Kuwait','Iran','India','Pakistan','International'],
    routeNotes: 'Yachts Logistics provides shipping/logistics support from Shinas Port, Oman to Iran.'
  };
  try {
    const response = await fetch(`${base}/rest/v1/company_profile?select=services,ports_covered,sending_limits&limit=1`, { headers });
    if (!response.ok) return fallback;
    const rows = await response.json();
    const p = rows?.[0];
    if (!p) return fallback;
    const services = Array.isArray(p.services) ? p.services.join(', ') : '';
    const ports = Array.isArray(p.ports_covered) ? p.ports_covered.join(', ') : '';
    const limits = p.sending_limits && typeof p.sending_limits === 'object' ? p.sending_limits : {};
    return {
      context: `Yachts Logistics, a company based in Oman${services ? ` offering: ${services}` : ''}${ports ? `, covering ports: ${ports}` : ''}`,
      targetMarkets: Array.isArray(limits.target_markets) && limits.target_markets.length ? limits.target_markets : fallback.targetMarkets,
      routeNotes: cleanString(limits.outreach_route_notes, 3000) || fallback.routeNotes
    };
  } catch (_) {
    return fallback;
  }
}

function buildPrompt(profile, limit, focusType, marketFocus, knownNames, lean) {
  const namesLine = (lean ? knownNames.slice(0, 20) : knownNames).join(', ');
  return `
You are researching REAL companies on behalf of ${profile.context}.

CURRENT MARKET FOCUS: ${marketFocus.name}
${marketFocus.instruction}
Overall priority markets configured by the business: ${profile.targetMarkets.join(', ')}.
Approved route note: ${profile.routeNotes}

CURRENT BUSINESS-TYPE FOCUS: ${focusType}.
This is a preference, not a hard filter. Return other strong relevant companies if the search finds them.

Classify every result into exactly one category:

"prospect" — normally a non-Oman company that could directly appoint, introduce or
refer work to Yachts Logistics: shipowner, ship manager, vessel operator, charterer,
shipbroker, freight forwarder, overseas agent, offshore/marine company, or relevant
trading/cargo company. It does NOT need a proven current Oman port call; evidence of a
real relevant maritime/logistics business is enough for discovery. Relevance Scorer
will decide how strong the lead is later.

"partner" — an Oman-based shipping agency or logistics/marine company that may hold
vessel/client relationships and could subcontract local operational work to Yachts
Logistics under a sub-agency/operational arrangement.

Do NOT include Oman's state-owned / fully integrated conglomerates such as Asyad.
Prefer smaller and mid-sized realistic prospects over famous global giants when both
are available.

Use web search and find up to ${limit} REAL companies. Never invent a company.
Avoid these already-known names where possible:
${namesLine || '(none yet)'}

For each company, source_url MUST be a real web result supporting that the company
exists and does the relevant business. Do not invent emails or people here.

Return ONLY a JSON array:
[
  {
    "company_name": "string",
    "country": "string",
    "website": "official website URL or null",
    "business_type": "one of: ${BUSINESS_TYPES.join(', ')}",
    "target_table": "prospect or partner",
    "relevance_reason": "one or two factual sentences",
    "source_url": "real supporting http/https URL"
  }
]
`.trim();
}

async function callGroq(apiKey, prompt) {
  let response;
  try {
    response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'groq/compound-mini',
        messages: [{ role: 'user', content: prompt }],
        compound_custom: { tools: { enabled_tools: ['web_search'] } }
      })
    });
  } catch (error) {
    return { ok: false, status: 502, errorText: error?.message || String(error), tokensUsed: 0 };
  }
  if (!response.ok) return { ok: false, status: response.status, errorText: await response.text(), tokensUsed: 0 };
  const json = await response.json();
  return { ok: true, status: response.status, json, tokensUsed: Number(json?.usage?.total_tokens) || 0 };
}

async function readSharedGroqUsageLast24Hours(base, headers) {
  try {
    const start = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const url = new URL(`${base}/rest/v1/activity_log`);
    url.searchParams.set('worker_name', `in.(${GROQ_WORKER_NAMES.map(n => `"${n}"`).join(',')})`);
    url.searchParams.set('created_at', `gte.${start}`);
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
      const failures = Array.isArray(detail.failures) ? detail.failures : [];
      const rejected = action.includes('http 429') || action.includes('http 413') || action.startsWith('skipped') ||
        failures.some(f => f?.stage === 'groq_api' && (Number(f?.status) === 429 || Number(f?.status) === 413));
      const explicitRequests = Number(detail.groq_requests);
      if (Number.isFinite(explicitRequests) && explicitRequests >= 0) requests += explicitRequests;
      else if (row.worker_name === 'Prospect Finder' && !rejected) requests += 1;

      const rowTokens = Number(detail.tokens_used);
      if (Number.isFinite(rowTokens) && rowTokens > 0) tokens += rowTokens;
      else if (Number.isFinite(explicitRequests) && explicitRequests > 0 && !rejected) {
        tokens += explicitRequests * ESTIMATED_GROQ_TOKENS_PER_REQUEST;
        estimatedTokenRows++;
      } else if (row.worker_name === 'Prospect Finder' && !rejected) {
        tokens += ESTIMATED_GROQ_TOKENS_PER_REQUEST;
        estimatedTokenRows++;
      }
    }
    return { ok: true, requests, tokens, rows_counted: (rows || []).length, estimated_token_rows: estimatedTokenRows };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}

async function logActivity(base, headers, action, detail) {
  try {
    await fetch(`${base}/rest/v1/activity_log`, {
      method: 'POST',
      headers: { ...headers, Prefer: 'return=minimal' },
      body: JSON.stringify({ worker_name: 'Prospect Finder', action, target_table: 'prospects', detail: detail || {} })
    });
  } catch (_) {}
}

async function fetchExistingCompanyNames(base, headers) {
  const pageSize = 1000;
  const names = [];
  for (let offset = 0; ; offset += pageSize) {
    const response = await fetch(`${base}/rest/v1/prospects?select=company_name&order=discovered_at.desc&limit=${pageSize}&offset=${offset}`, { headers });
    if (!response.ok) throw new Error(`Could not read existing prospects: ${await response.text()}`);
    const page = await response.json();
    names.push(...(page || []).map(p => normalizeCompanyName(p.company_name)).filter(Boolean));
    if (!page || page.length < pageSize) break;
  }
  return names;
}

function extractHttpUrls(text) { return String(text || '').match(/https?:\/\/[^\s"'\\]+/g) || []; }
function safeHostname(rawUrl) {
  try { return new URL(rawUrl).hostname.replace(/^www\./, '').toLowerCase(); } catch (_) { return null; }
}
function isGroundedUrl(rawUrl, groundedHosts) {
  const claimed = safeHostname(rawUrl);
  return Boolean(claimed && groundedHosts.some(h => h === claimed || h.endsWith(`.${claimed}`) || claimed.endsWith(`.${h}`)));
}
function normalizeHttpUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const u = new URL(value.trim());
    return (u.protocol === 'http:' || u.protocol === 'https:') ? u.toString().slice(0, 2000) : null;
  } catch (_) { return null; }
}
function normalizeCompanyName(value) {
  return String(value || '').normalize('NFKC').toLowerCase().replace(/&/g, ' and ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}
function cleanString(value, max) { return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null; }
function clip(value, max) { return String(value || '').slice(0, max); }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function jsonResponse(status, body) { return new Response(JSON.stringify(body, null, 2), { status, headers: { 'Content-Type': 'application/json' } }); }
