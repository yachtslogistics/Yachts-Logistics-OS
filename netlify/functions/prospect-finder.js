// Prospect Finder worker
//
// What it does, in order:
// 1. Asks Gemini (with Google Search grounding turned on) to find real
//    shipping/marine companies that could plausibly need Oman-based
//    logistics support.
// 2. Cross-checks EACH company's source URL against the actual grounding
//    results Gemini returned — not just "did grounding happen somewhere in
//    the response." A company only survives if its own claimed source
//    matches a real grounded search result.
// 3. Skips anything that's already in the `prospects` table (by name).
// 4. Inserts the rest into Supabase — unless dry-run mode is on, in which
//    case nothing is written, you just see what WOULD have happened.
// 5. Writes one summary row to activity_log so the run is visible.
//
// Call it with ?dry_run=true first (recommended) to see the results before
// anything touches your database. Only add &live=true once you've checked
// the output and you're happy with it.
//
// This is meant to be called manually for now (from a browser or a tool
// like Postman) to test it. Wiring it to a schedule is a later step.
//
// Required environment variables (set in Netlify → Environment variables):
//   GEMINI_API_KEY        - your Gemini API key
//   SUPABASE_URL           - your Supabase project URL
//   SUPABASE_SERVICE_KEY   - your Supabase SECRET key (not the publishable one —
//                            this worker runs with no logged-in user, so it
//                            needs the key that bypasses RLS on purpose)
//   WORKER_SECRET           - any password you make up yourself, used so random
//                            people on the internet can't trigger this and burn
//                            your free API quota

import { createClient } from '@supabase/supabase-js';

const BUSINESS_TYPES = [
  'Shipowner', 'Ship Manager', 'Vessel Operator', 'Charterer',
  'Shipbroker', 'Freight Forwarder', 'Offshore & Marine', 'Overseas Agent'
];

export default async (req) => {
  try {
    // --- 1. Simple shared-secret check so this can't be triggered by strangers ---
    const providedSecret = req.headers.get('x-worker-secret');
    if (!process.env.WORKER_SECRET || providedSecret !== process.env.WORKER_SECRET) {
      return jsonResponse(401, { error: 'Missing or incorrect x-worker-secret header.' });
    }

    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

    if (!GEMINI_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
      return jsonResponse(500, { error: 'Missing one of GEMINI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY in environment variables.' });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    // Small batch on purpose — this is not meant to run one giant search.
    const url = new URL(req.url);
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '8', 10), 15);

    // Safety default: nothing gets written unless the caller explicitly
    // passes live=true. Dry runs show you exactly what would happen.
    const isLive = url.searchParams.get('live') === 'true';

    // --- 2. Pull existing company names so Gemini can be told to avoid duplicates ---
    const { data: existing, error: existingError } = await supabase
      .from('prospects')
      .select('company_name');

    if (existingError) {
      return jsonResponse(500, { error: `Could not read existing prospects: ${existingError.message}` });
    }

    const existingNames = (existing || []).map(p => (p.company_name || '').toLowerCase());

    // --- 3. Ask Gemini, with real web search grounding turned on ---
    const prompt = `
You are researching real companies for a marine and offshore logistics business
based in Oman (ports: Sohar, Duqm, Salalah, Muscat) that wants to find potential
clients or partners.

Find up to ${limit} REAL companies (not invented) that are shipowners, ship
managers, vessel operators, charterers, shipbrokers, freight forwarders,
offshore/marine service companies, or overseas agents who may plausibly need
logistics, husbandry, crew change, or port agency support in Oman.

Do not include any of these companies, they are already known:
${existingNames.length ? existingNames.join(', ') : '(none yet)'}

For each company, return only information you can support with a real source
you found via search. If you cannot find a real source URL for a company,
leave it out entirely rather than guessing.

Respond with ONLY a JSON array (no markdown, no explanation) in this exact shape:
[
  {
    "company_name": "string",
    "country": "string",
    "website": "string or null",
    "business_type": "one of: ${BUSINESS_TYPES.join(', ')}",
    "relevance_reason": "one or two sentences on why this company might need Oman-based logistics support",
    "source_url": "a real URL you found via search that supports this entry"
  }
]
`.trim();

    // Diagnostic switch: ?no_grounding=true runs a plain call with no search
    // tool attached, purely to test whether Gemini itself is reachable,
    // separate from any grounding-specific quota issue.
    const useGrounding = url.searchParams.get('no_grounding') !== 'true';

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          ...(useGrounding ? { tools: [{ google_search: {} }] } : {})
        })
      }
    );

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      return jsonResponse(502, { error: `Gemini request failed: ${errText}` });
    }

    const geminiData = await geminiRes.json();
    const candidate = geminiData.candidates && geminiData.candidates[0];
    const rawText = candidate?.content?.parts?.map(p => p.text).join('') || '';

    // Pull out the actual list of URLs Gemini's search grounding really
    // returned. This is the ground truth we check every company against —
    // not just "grounding happened somewhere."
    const groundingChunks = candidate?.groundingMetadata?.groundingChunks || [];
    const groundedHosts = groundingChunks
      .map(chunk => chunk?.web?.uri)
      .filter(Boolean)
      .map(uri => safeHostname(uri))
      .filter(Boolean);

    let companies = [];
    try {
      const cleaned = rawText.replace(/```json/gi, '').replace(/```/g, '').trim();
      companies = JSON.parse(cleaned);
    } catch (e) {
      return jsonResponse(502, { error: 'Could not parse Gemini output as JSON.', raw: rawText.slice(0, 800) });
    }

    if (groundedHosts.length === 0) {
      await logActivity(supabase, 'Prospect Finder', 'Run aborted — no real search grounding returned, refusing to insert unverified data.', null, { attempted: companies.length });
      return jsonResponse(200, { inserted: 0, skipped: 0, reason: 'No search grounding present in Gemini response — nothing inserted for safety.' });
    }

    // --- 4. Filter, dedupe, verify each source against real grounding, and insert ---
    let inserted = 0;
    let skippedDuplicate = 0;
    let skippedNoEvidence = 0;
    let skippedUnverifiedSource = 0;
    const insertedNames = [];
    const wouldInsert = [];

    for (const c of companies) {
      if (!c.company_name || !c.source_url) {
        skippedNoEvidence++;
        continue;
      }
      if (existingNames.includes(c.company_name.toLowerCase())) {
        skippedDuplicate++;
        continue;
      }

      // The company's claimed source must match a host Gemini's search
      // grounding actually returned. This stops a company slipping through
      // with a source URL Gemini invented rather than actually found.
      const claimedHost = safeHostname(c.source_url);
      const isVerified = claimedHost && groundedHosts.some(h => h === claimedHost || h.endsWith(`.${claimedHost}`) || claimedHost.endsWith(`.${h}`));

      if (!isVerified) {
        skippedUnverifiedSource++;
        continue;
      }

      const record = {
        company_name: c.company_name,
        country: c.country || null,
        website: c.website || null,
        business_type: BUSINESS_TYPES.includes(c.business_type) ? c.business_type : 'Other',
        relevance_reason: c.relevance_reason || null,
        source_links: [c.source_url],
        status: 'discovered'
      };

      if (!isLive) {
        wouldInsert.push(record);
        existingNames.push(c.company_name.toLowerCase());
        continue;
      }

      const { error: insertError } = await supabase.from('prospects').insert(record);
      if (!insertError) {
        inserted++;
        insertedNames.push(c.company_name);
        existingNames.push(c.company_name.toLowerCase());
      }
    }

    if (!isLive) {
      // Dry run — report what would happen, write nothing.
      return jsonResponse(200, {
        mode: 'DRY RUN — nothing was written to the database. Add &live=true to actually insert.',
        found: companies.length,
        would_insert: wouldInsert.length,
        would_insert_details: wouldInsert,
        skipped_duplicate: skippedDuplicate,
        skipped_no_evidence: skippedNoEvidence,
        skipped_unverified_source: skippedUnverifiedSource
      });
    }

    // --- 5. Log the run (live mode only) ---
    await logActivity(
      supabase,
      'Prospect Finder',
      `Run complete — found ${companies.length}, inserted ${inserted}, skipped ${skippedDuplicate} duplicates, ${skippedNoEvidence} without evidence, ${skippedUnverifiedSource} with unverified sources.`,
      null,
      { inserted_names: insertedNames }
    );

    return jsonResponse(200, {
      mode: 'LIVE — changes were written to the database.',
      found: companies.length,
      inserted,
      skipped_duplicate: skippedDuplicate,
      skipped_no_evidence: skippedNoEvidence,
      skipped_unverified_source: skippedUnverifiedSource,
      inserted_names: insertedNames
    });

  } catch (err) {
    return jsonResponse(500, { error: err.message || String(err) });
  }
};

async function logActivity(supabase, workerName, action, targetId, detail) {
  try {
    await supabase.from('activity_log').insert({
      worker_name: workerName,
      action,
      target_table: 'prospects',
      target_id: targetId,
      detail: detail || {}
    });
  } catch (e) {
    // Never let logging failure break the run.
  }
}

function safeHostname(rawUrl) {
  try {
    return new URL(rawUrl).hostname.replace(/^www\./, '').toLowerCase();
  } catch (e) {
    return null;
  }
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}
