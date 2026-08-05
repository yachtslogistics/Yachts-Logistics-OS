// Yachts Logistics OS — Relevance Scorer v3.1
//
// Same job as the current scorer, but ALL AI generation goes through AI Router v2.
// The Router decides OpenAI Luna vs Gemini based on the Settings button,
// OpenAI monthly budget pacing, and Gemini's shared daily request budget.
//
// Required Worker variables/secrets:
//   AI_ROUTER_URL           Plain text, e.g. https://yachts-ai-router....workers.dev
//   ROUTER_SECRET           Secret (must match AI Router)
//   SUPABASE_URL            Plain text
//   SUPABASE_SERVICE_KEY    Secret
//   WORKER_SECRET           Secret
//
// Existing Cron can stay unchanged. Scheduled runs score up to 20 prospects.

const DEFAULT_BATCH_SIZE = 10;
const MAX_BATCH_SIZE = 25;
const SCHEDULED_BATCH_SIZE = 20;

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

    const result = await runScorer(env, batchSize, isLive);
    return jsonResponse(result.status, result.body);
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runScorer(env, SCHEDULED_BATCH_SIZE, true));
  }
};

async function runScorer(env, batchSize, isLive) {
  const missing = ['AI_ROUTER_URL', 'ROUTER_SECRET', 'SUPABASE_URL', 'SUPABASE_SERVICE_KEY']
    .filter(name => !env[name]);
  if (missing.length) return { status: 500, body: { error: 'Missing Worker variables.', missing } };

  const sbHeaders = {
    apikey: env.SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json'
  };

  try {
    const companyContext = await readCompanyContext(env.SUPABASE_URL, sbHeaders);
    const prospectsResult = await readWaitingProspects(env.SUPABASE_URL, sbHeaders, batchSize);
    if (!prospectsResult.ok) {
      return { status: 500, body: { error: `Could not read prospects: ${prospectsResult.error}` } };
    }

    const prospects = prospectsResult.rows;
    if (!prospects.length) {
      return { status: 200, body: { scored: 0, reason: 'No unscored prospects waiting right now.' } };
    }

    const prompt = buildBatchPrompt(companyContext, prospects);
    const routed = await callRouter(env, {
      task_type: 'relevance_score',
      worker_name: 'Relevance Scorer',
      prompt,
      max_output_tokens: 3200
    });

    if (!routed.ok) {
      const action = routed.status === 429
        ? 'Skipped — AI Router has both providers protected or unavailable.'
        : `Scoring run failed — AI Router returned HTTP ${routed.status}.`;
      await logActivity(env.SUPABASE_URL, sbHeaders, action, {
        live: isLive,
        router_error: clip(routed.error, 1000),
        router_detail: routed.data || null,
        target_count: prospects.length
      });
      return { status: routed.status === 429 ? 200 : 502, body: routed.status === 429 ? { skipped: true, reason: routed.error, router: routed.data } : { error: routed.error, router: routed.data } };
    }

    const parsed = parseScoreArray(routed.output);
    if (!parsed.ok) {
      await logActivity(env.SUPABASE_URL, sbHeaders, 'Scoring run failed — routed AI output was not valid score JSON.', {
        provider: routed.provider,
        live: isLive,
        error: parsed.error,
        response_excerpt: clip(routed.output, 1000)
      });
      return { status: 502, body: { error: parsed.error, provider: routed.provider } };
    }

    const prospectById = new Map(prospects.map(p => [String(p.id), p]));
    const results = [];
    const failures = [];
    const seen = new Set();

    for (const row of parsed.rows) {
      const prospectId = cleanString(row.prospect_id, 120);
      if (!prospectId || !prospectById.has(prospectId)) {
        failures.push({ prospect_id: prospectId, stage: 'unknown_prospect_id' });
        continue;
      }
      if (seen.has(prospectId)) {
        failures.push({ prospect_id: prospectId, stage: 'duplicate_model_row' });
        continue;
      }

      const score = clampScore(row.oman_relevance_score);
      const reason = cleanString(row.relevance_reason, 1000);
      if (score === null || !reason) {
        failures.push({ prospect_id: prospectId, company_name: prospectById.get(prospectId).company_name, stage: 'invalid_score_or_reason' });
        continue;
      }

      seen.add(prospectId);
      const prospect = prospectById.get(prospectId);

      if (isLive) {
        const update = await fetch(`${env.SUPABASE_URL}/rest/v1/prospects?id=eq.${encodeURIComponent(prospect.id)}`, {
          method: 'PATCH',
          headers: { ...sbHeaders, Prefer: 'return=minimal' },
          body: JSON.stringify({
            oman_relevance_score: score,
            relevance_reason: reason,
            status: 'researched',
            updated_at: new Date().toISOString()
          })
        });
        if (!update.ok) {
          failures.push({ company_name: prospect.company_name, stage: 'supabase_update', error: clip(await update.text(), 700) });
          continue;
        }
      }

      results.push({ prospect_id: prospect.id, company_name: prospect.company_name, score, reason });
    }

    const missingRows = prospects.filter(p => !seen.has(String(p.id)));
    for (const p of missingRows) {
      if (!failures.some(f => String(f.prospect_id || '') === String(p.id))) {
        failures.push({ prospect_id: p.id, company_name: p.company_name, stage: 'no_model_row' });
      }
    }

    await logActivity(
      env.SUPABASE_URL,
      sbHeaders,
      `Scoring run complete (${isLive ? 'live' : 'dry run'}) via ${providerLabel(routed.provider)} — scored ${results.length}, failed ${failures.length} out of ${prospects.length} checked.`,
      {
        live: isLive,
        provider: routed.provider,
        model: routed.model,
        fallback_used: routed.fallback_used,
        results,
        failures
      }
    );

    return {
      status: 200,
      body: {
        mode: isLive ? 'LIVE — scores were written to the database.' : 'DRY RUN — nothing was written. Add &live=true to update.',
        provider: routed.provider,
        model: routed.model,
        fallback_used: routed.fallback_used,
        checked: prospects.length,
        scored: results.length,
        failed: failures.length,
        results,
        failures
      }
    };
  } catch (error) {
    const message = clip(error?.message || String(error), 1000);
    await logActivity(env.SUPABASE_URL, sbHeaders, 'Relevance Scorer failed unexpectedly.', { error: message, live: isLive });
    return { status: 500, body: { error: message } };
  }
}

async function callRouter(env, payload) {
  try {
    const response = await fetch(`${String(env.AI_ROUTER_URL).replace(/\/+$/, '')}/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-router-secret': env.ROUTER_SECRET
      },
      body: JSON.stringify(payload)
    });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch (_) { data = null; }
    if (!response.ok || !data?.ok) {
      return { ok: false, status: response.status, error: data?.error || clip(text, 1000), data };
    }
    return {
      ok: true,
      status: response.status,
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

async function readCompanyContext(base, headers) {
  let context = 'Yachts Logistics, a marine and offshore logistics company based in Oman';
  try {
    const response = await fetch(`${base}/rest/v1/company_profile?select=services,ports_covered,sending_limits&limit=1`, { headers });
    if (!response.ok) return context;
    const rows = await response.json();
    const p = rows?.[0];
    if (!p) return context;
    const services = Array.isArray(p.services) ? p.services.join(', ') : '';
    const ports = Array.isArray(p.ports_covered) ? p.ports_covered.join(', ') : '';
    const limits = p.sending_limits && typeof p.sending_limits === 'object' ? p.sending_limits : {};
    const markets = Array.isArray(limits.target_markets) ? limits.target_markets.join(', ') : 'GCC, Iran, India, Pakistan, international';
    const routeNotes = cleanString(limits.outreach_route_notes, 2500) || 'Yachts Logistics provides shipping/logistics support from Shinas Port, Oman to Iran.';
    context = `Yachts Logistics${services ? `, offering: ${services}` : ''}${ports ? `, covering ports: ${ports}` : ''}. Priority markets: ${markets}. Approved route note: ${routeNotes}`;
  } catch (_) {}
  return context;
}

async function readWaitingProspects(base, headers, limit) {
  const url = new URL(`${base}/rest/v1/prospects`);
  url.searchParams.set('status', 'eq.discovered');
  url.searchParams.set('oman_relevance_score', 'is.null');
  url.searchParams.set('select', 'id,company_name,country,business_type,relevance_reason,source_links,website,discovered_at');
  url.searchParams.set('order', 'discovered_at.asc');
  url.searchParams.set('limit', String(limit));
  const response = await fetch(url.toString(), { headers });
  if (!response.ok) return { ok: false, error: clip(await response.text(), 1000) };
  return { ok: true, rows: await response.json() };
}

function buildBatchPrompt(companyContext, prospects) {
  const facts = prospects.map(p => ({
    prospect_id: String(p.id),
    company_name: p.company_name,
    country: p.country || null,
    business_type: p.business_type || null,
    existing_notes: p.relevance_reason || null,
    website: p.website || null,
    source_evidence: Array.isArray(p.source_links) ? p.source_links : []
  }));

  return `
You are the Oman relevance scoring step for ${companyContext}.

The companies below were already found by a separate evidence-backed research worker.
Use ONLY the supplied facts. Do not add facts from memory and do not invent vessels,
contacts, routes, port calls, customers, licenses, or relationships. Thin evidence is
not a failure: score conservatively and explain the uncertainty.

Score how useful each company is as a possible client, introducer, broker, ship
manager, owner, operator, freight/logistics partner, cargo/trading connection, or other
legitimate source of Oman marine/offshore work for Yachts Logistics. Relevant Iran ↔ Oman
trade/logistics prospects may score highly when the supplied facts fit the approved Shinas
Port → Iran route. Do not require proof of a current Oman port call to give a useful score.

Return ONLY a JSON array. For every supplied prospect return exactly one object:
[
  {
    "prospect_id": "copy the exact prospect_id",
    "oman_relevance_score": 0,
    "relevance_reason": "short factual reason based only on the supplied evidence"
  }
]

PROSPECTS:
${JSON.stringify(facts, null, 2)}
`.trim();
}

function parseScoreArray(rawText) {
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

async function logActivity(base, headers, action, detail) {
  try {
    await fetch(`${base}/rest/v1/activity_log`, {
      method: 'POST',
      headers: { ...headers, Prefer: 'return=minimal' },
      body: JSON.stringify({ worker_name: 'Relevance Scorer', action, target_table: 'prospects', detail: detail || {} })
    });
  } catch (_) {}
}

function clampScore(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}
function cleanString(value, max) { return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null; }
function providerLabel(provider) { return provider === 'openai' ? 'OpenAI Luna' : provider === 'gemini' ? 'Gemini' : String(provider || 'AI Router'); }
function clip(value, max) { return String(value || '').slice(0, max); }
function jsonResponse(status, body) { return new Response(JSON.stringify(body, null, 2), { status, headers: { 'Content-Type': 'application/json' } }); }
