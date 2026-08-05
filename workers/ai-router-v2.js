// Yachts Logistics OS — AI Router v2
//
// One provider switch for the AI jobs that do NOT need web research.
// - OpenAI ON: prefer GPT-5.6 Luna, but enforce a hard monthly budget and
//   daily pacing so a small credit balance lasts through the month.
// - OpenAI OFF / paced / exhausted / unavailable: fall back to Gemini.
// - Gemini usage is counted by REQUEST, shared across every routed worker.
// - No Cron handler. Other workers call POST /generate.
// - All provider attempts are written to public.api_usage.
//
// Required Worker variables/secrets:
//   OPENAI_API_KEY          Secret
//   GEMINI_API_KEY          Secret
//   SUPABASE_URL            Plain text
//   SUPABASE_SERVICE_KEY    Secret
//   ROUTER_SECRET           Secret
//
// Settings are read from company_profile.sending_limits:
//   ai_openai_enabled             boolean (default true)
//   openai_monthly_budget_usd     number  (default/hard max 4.50)
//   gemini_daily_request_limit    integer (default 20, hard max 24)

const VERSION = '2.0.0';
const OPENAI_MODEL = 'gpt-5.6-luna';
const GEMINI_MODEL = 'gemini-flash-latest';

// Official GPT-5.6 Luna text pricing, USD per 1M tokens.
const LUNA_INPUT_USD_PER_MILLION = 1.00;
const LUNA_CACHED_INPUT_USD_PER_MILLION = 0.10;
const LUNA_CACHE_WRITE_USD_PER_MILLION = 1.25;
const LUNA_OUTPUT_USD_PER_MILLION = 6.00;

const HARD_OPENAI_MONTHLY_LIMIT_USD = 4.50;
const DEFAULT_OPENAI_MONTHLY_LIMIT_USD = 4.50;
const HARD_GEMINI_DAILY_REQUEST_LIMIT = 24;
const DEFAULT_GEMINI_DAILY_REQUEST_LIMIT = 20;

const ALLOWED_TASKS = new Set(['relevance_score', 'outreach_draft']);
const MAX_BODY_CHARS = 60_000;
const MAX_PROMPT_CHARS = 50_000;
const MIN_OUTPUT_TOKENS = 64;
const MAX_OUTPUT_TOKENS = 6_000;

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);

      if (request.method === 'GET' && url.pathname === '/') {
        return jsonResponse(200, {
          ok: true,
          worker: 'yachts-ai-router',
          version: VERSION,
          status: 'ready',
          routes: ['GET /health', 'POST /generate'],
          ai_call_made: false
        });
      }

      if (!(await isAuthorized(request, env.ROUTER_SECRET))) {
        return jsonResponse(401, { ok: false, error: 'Missing or incorrect x-router-secret header.' });
      }

      const baseMissing = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY'].filter(name => !env[name]);
      if (baseMissing.length) {
        return jsonResponse(500, { ok: false, error: 'Required Router variables are missing.', missing: baseMissing });
      }

      if (request.method === 'GET' && url.pathname === '/health') {
        return handleHealth(env);
      }

      if (request.method === 'POST' && url.pathname === '/generate') {
        return handleGenerate(request, env);
      }

      return jsonResponse(404, { ok: false, error: 'Route not found.' });
    } catch (error) {
      return jsonResponse(500, { ok: false, error: 'Unexpected router error.', detail: safeErrorMessage(error) });
    }
  }
};

async function handleHealth(env) {
  const [controlsResult, openaiResult, geminiResult] = await Promise.all([
    readAiControls(env),
    readOpenAIUsage(env),
    readGeminiUsageToday(env)
  ]);

  if (!controlsResult.ok || !openaiResult.ok || !geminiResult.ok) {
    return jsonResponse(500, {
      ok: false,
      ai_call_made: false,
      error: 'Could not safely read AI controls/usage.',
      detail: {
        controls: controlsResult.error || null,
        openai: openaiResult.error || null,
        gemini: geminiResult.error || null
      }
    });
  }

  const controls = controlsResult.controls;
  const pace = calculateOpenAIDailyPace(openaiResult, controls.openaiMonthlyBudgetUsd);

  return jsonResponse(200, {
    ok: true,
    worker: 'yachts-ai-router',
    version: VERSION,
    ai_call_made: false,
    preferred_provider: controls.openaiEnabled ? 'openai' : 'gemini',
    openai: {
      configured: Boolean(env.OPENAI_API_KEY),
      enabled_by_button: controls.openaiEnabled,
      model: OPENAI_MODEL,
      monthly_budget_usd: controls.openaiMonthlyBudgetUsd,
      month_spend_usd: roundUsd(openaiResult.monthSpendUsd),
      month_remaining_usd: roundUsd(Math.max(0, controls.openaiMonthlyBudgetUsd - openaiResult.monthSpendUsd)),
      today_spend_usd: roundUsd(openaiResult.todaySpendUsd),
      today_pacing_allowance_usd: roundUsd(pace.todayAllowanceUsd),
      paced_for_today: pace.todayRemainingUsd <= 0
    },
    gemini: {
      configured: Boolean(env.GEMINI_API_KEY),
      model: GEMINI_MODEL,
      requests_today: geminiResult.requestsToday,
      daily_worker_limit: controls.geminiDailyRequestLimit,
      hard_known_limit: HARD_GEMINI_DAILY_REQUEST_LIMIT
    }
  });
}

async function handleGenerate(request, env) {
  const bodyResult = await readJsonBody(request);
  if (!bodyResult.ok) return jsonResponse(bodyResult.status, { ok: false, error: bodyResult.error, ai_call_made: false });

  const body = bodyResult.value;
  const taskType = cleanString(body.task_type, 80);
  const workerName = cleanString(body.worker_name, 120);
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  const requestedMax = Number(body.max_output_tokens);
  const maxOutputTokens = Number.isFinite(requestedMax)
    ? Math.max(MIN_OUTPUT_TOKENS, Math.min(MAX_OUTPUT_TOKENS, Math.floor(requestedMax)))
    : (taskType === 'outreach_draft' ? 4500 : 3200);

  if (!taskType || !ALLOWED_TASKS.has(taskType)) {
    return jsonResponse(400, { ok: false, error: 'task_type must be relevance_score or outreach_draft.', ai_call_made: false });
  }
  if (!workerName) {
    return jsonResponse(400, { ok: false, error: 'worker_name is required.', ai_call_made: false });
  }
  if (!prompt || prompt.length > MAX_PROMPT_CHARS) {
    return jsonResponse(400, { ok: false, error: `prompt is required and must be <= ${MAX_PROMPT_CHARS} characters.`, ai_call_made: false });
  }

  const controlsResult = await readAiControls(env);
  if (!controlsResult.ok) {
    return jsonResponse(500, { ok: false, error: 'Could not read AI provider controls. No AI call was made.', detail: controlsResult.error, ai_call_made: false });
  }
  const controls = controlsResult.controls;

  const providerAttempts = [];

  if (controls.openaiEnabled && env.OPENAI_API_KEY) {
    const openaiUsage = await readOpenAIUsage(env);
    if (!openaiUsage.ok) {
      providerAttempts.push({ provider: 'openai', used: false, reason: `usage_check_failed: ${openaiUsage.error}` });
    } else {
      const reserveUsd = estimateMaximumLunaRequestCost(prompt, maxOutputTokens);
      const pace = calculateOpenAIDailyPace(openaiUsage, controls.openaiMonthlyBudgetUsd);
      const monthRemaining = Math.max(0, controls.openaiMonthlyBudgetUsd - openaiUsage.monthSpendUsd);

      if (reserveUsd <= monthRemaining && reserveUsd <= pace.todayRemainingUsd) {
        const openaiResult = await callOpenAI(env, { taskType, workerName, prompt, maxOutputTokens });
        providerAttempts.push({ provider: 'openai', used: true, ok: openaiResult.ok, status: openaiResult.status });

        if (openaiResult.ok) {
          return jsonResponse(200, {
            ok: true,
            provider: 'openai',
            model: OPENAI_MODEL,
            output: openaiResult.output,
            usage: openaiResult.usage,
            fallback_used: false,
            provider_attempts: providerAttempts,
            ai_call_made: true
          });
        }
      } else {
        providerAttempts.push({
          provider: 'openai',
          used: false,
          reason: reserveUsd > monthRemaining ? 'monthly_budget_protected' : 'daily_pacing_protected',
          reserve_usd: roundUsd(reserveUsd),
          month_remaining_usd: roundUsd(monthRemaining),
          today_remaining_usd: roundUsd(pace.todayRemainingUsd)
        });
      }
    }
  } else {
    providerAttempts.push({
      provider: 'openai',
      used: false,
      reason: controls.openaiEnabled ? 'openai_key_missing' : 'paused_by_settings_button'
    });
  }

  // Gemini is the automatic fallback and the primary provider when OpenAI is OFF.
  if (!env.GEMINI_API_KEY) {
    return jsonResponse(503, {
      ok: false,
      error: 'OpenAI was unavailable/paused and GEMINI_API_KEY is not configured.',
      provider_attempts: providerAttempts,
      ai_call_made: providerAttempts.some(a => a.used)
    });
  }

  const geminiUsage = await readGeminiUsageToday(env);
  if (!geminiUsage.ok) {
    return jsonResponse(500, {
      ok: false,
      error: 'Could not verify Gemini request usage safely. No Gemini call was made.',
      detail: geminiUsage.error,
      provider_attempts: providerAttempts,
      ai_call_made: providerAttempts.some(a => a.used)
    });
  }

  if (geminiUsage.requestsToday >= controls.geminiDailyRequestLimit) {
    providerAttempts.push({
      provider: 'gemini',
      used: false,
      reason: 'daily_request_budget_protected',
      requests_today: geminiUsage.requestsToday,
      daily_limit: controls.geminiDailyRequestLimit
    });
    return jsonResponse(429, {
      ok: false,
      error: 'Both AI routes are currently protected/unavailable.',
      provider_attempts: providerAttempts,
      ai_call_made: providerAttempts.some(a => a.used)
    });
  }

  const geminiResult = await callGemini(env, { taskType, workerName, prompt });
  providerAttempts.push({ provider: 'gemini', used: true, ok: geminiResult.ok, status: geminiResult.status });

  if (!geminiResult.ok) {
    return jsonResponse(502, {
      ok: false,
      error: 'Gemini fallback failed.',
      provider_attempts: providerAttempts,
      provider_message: geminiResult.error,
      ai_call_made: true
    });
  }

  return jsonResponse(200, {
    ok: true,
    provider: 'gemini',
    model: GEMINI_MODEL,
    output: geminiResult.output,
    usage: geminiResult.usage,
    fallback_used: true,
    provider_attempts: providerAttempts,
    ai_call_made: true
  });
}

async function callOpenAI(env, { taskType, workerName, prompt, maxOutputTokens }) {
  const startedAt = Date.now();
  let response;
  let rawText = '';
  let data = null;

  try {
    response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        input: prompt,
        reasoning: { effort: 'none' },
        text: { verbosity: 'low' },
        max_output_tokens: maxOutputTokens,
        store: false,
        metadata: {
          application: 'yachts-logistics-os',
          worker: workerName.slice(0, 64),
          task: taskType
        }
      })
    });
    rawText = await response.text();
    data = parseJsonSafely(rawText);
  } catch (error) {
    const detail = safeErrorMessage(error);
    await logUsage(env, {
      provider: 'openai', model: OPENAI_MODEL, worker_name: workerName, task_type: taskType,
      status: 'failed', error_code: 'network_error', detail: { error: detail, ai_call_made: true, duration_ms: Date.now() - startedAt }
    });
    return { ok: false, status: 502, error: detail };
  }

  const requestId = data?.id || response.headers.get('x-request-id') || null;
  if (!response.ok) {
    const providerError = extractProviderError(data, rawText);
    await logUsage(env, {
      provider: 'openai', model: OPENAI_MODEL, worker_name: workerName, task_type: taskType,
      provider_request_id: requestId, status: 'failed', error_code: providerError.code || `http_${response.status}`,
      detail: { message: providerError.message, http_status: response.status, ai_call_made: true, duration_ms: Date.now() - startedAt }
    });
    return { ok: false, status: response.status, error: providerError.message };
  }

  const tokenUsage = normalizeOpenAIUsage(data?.usage);
  const estimatedCostUsd = calculateLunaCost(tokenUsage);
  const output = extractOpenAIOutputText(data);

  await logUsage(env, {
    provider: 'openai', model: OPENAI_MODEL, worker_name: workerName, task_type: taskType,
    provider_request_id: requestId,
    input_tokens: tokenUsage.inputTokens,
    output_tokens: tokenUsage.outputTokens,
    total_tokens: tokenUsage.totalTokens,
    estimated_cost_usd: estimatedCostUsd,
    status: 'completed',
    detail: {
      cached_input_tokens: tokenUsage.cachedInputTokens,
      cache_write_input_tokens: tokenUsage.cacheWriteInputTokens,
      reasoning_output_tokens: tokenUsage.reasoningOutputTokens,
      prompt_chars: prompt.length,
      ai_call_made: true,
      duration_ms: Date.now() - startedAt
    }
  });

  if (!output) return { ok: false, status: 502, error: 'OpenAI returned no output text.' };

  return {
    ok: true,
    status: response.status,
    output,
    usage: {
      input_tokens: tokenUsage.inputTokens,
      output_tokens: tokenUsage.outputTokens,
      total_tokens: tokenUsage.totalTokens,
      estimated_cost_usd: roundUsd(estimatedCostUsd)
    }
  };
}

async function callGemini(env, { taskType, workerName, prompt }) {
  const startedAt = Date.now();
  let response;
  let rawText = '';
  let data = null;

  try {
    response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: taskType === 'outreach_draft' ? 0.35 : 0.15 }
        })
      }
    );
    rawText = await response.text();
    data = parseJsonSafely(rawText);
  } catch (error) {
    const detail = safeErrorMessage(error);
    await logUsage(env, {
      provider: 'gemini', model: GEMINI_MODEL, worker_name: workerName, task_type: taskType,
      status: 'failed', error_code: 'network_error', detail: { error: detail, ai_call_made: true, duration_ms: Date.now() - startedAt }
    });
    return { ok: false, status: 502, error: detail };
  }

  const requestId = response.headers.get('x-request-id') || null;
  if (!response.ok) {
    const providerMessage = data?.error?.message || rawText.slice(0, 700) || `HTTP ${response.status}`;
    await logUsage(env, {
      provider: 'gemini', model: GEMINI_MODEL, worker_name: workerName, task_type: taskType,
      provider_request_id: requestId, status: 'failed', error_code: data?.error?.status || `http_${response.status}`,
      detail: { message: providerMessage, http_status: response.status, ai_call_made: true, duration_ms: Date.now() - startedAt }
    });
    return { ok: false, status: response.status, error: providerMessage };
  }

  const output = data?.candidates?.[0]?.content?.parts?.map(p => p?.text || '').join('')?.trim() || '';
  const usage = normalizeGeminiUsage(data?.usageMetadata || {});

  await logUsage(env, {
    provider: 'gemini', model: GEMINI_MODEL, worker_name: workerName, task_type: taskType,
    provider_request_id: requestId,
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    total_tokens: usage.totalTokens,
    estimated_cost_usd: 0,
    status: 'completed',
    detail: { prompt_chars: prompt.length, ai_call_made: true, duration_ms: Date.now() - startedAt }
  });

  if (!output) return { ok: false, status: 502, error: 'Gemini returned no output text.' };
  return {
    ok: true,
    status: response.status,
    output,
    usage: { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens, total_tokens: usage.totalTokens, estimated_cost_usd: 0 }
  };
}

async function readAiControls(env) {
  try {
    const url = new URL(`${trimTrailingSlash(env.SUPABASE_URL)}/rest/v1/company_profile`);
    url.searchParams.set('select', 'sending_limits');
    url.searchParams.set('limit', '1');
    const response = await fetch(url.toString(), { headers: supabaseHeaders(env) });
    if (!response.ok) return { ok: false, error: `Supabase company_profile read failed (${response.status}): ${await limitedText(response)}` };
    const rows = await response.json();
    const limits = rows?.[0]?.sending_limits && typeof rows[0].sending_limits === 'object' ? rows[0].sending_limits : {};

    const requestedBudget = finiteNonNegativeNumber(limits.openai_monthly_budget_usd ?? DEFAULT_OPENAI_MONTHLY_LIMIT_USD);
    const requestedGemini = finiteNonNegativeInteger(limits.gemini_daily_request_limit ?? DEFAULT_GEMINI_DAILY_REQUEST_LIMIT);

    return {
      ok: true,
      controls: {
        openaiEnabled: limits.ai_openai_enabled !== false,
        openaiMonthlyBudgetUsd: Math.min(HARD_OPENAI_MONTHLY_LIMIT_USD, requestedBudget || DEFAULT_OPENAI_MONTHLY_LIMIT_USD),
        geminiDailyRequestLimit: Math.max(1, Math.min(HARD_GEMINI_DAILY_REQUEST_LIMIT, requestedGemini || DEFAULT_GEMINI_DAILY_REQUEST_LIMIT))
      }
    };
  } catch (error) {
    return { ok: false, error: safeErrorMessage(error) };
  }
}

async function readOpenAIUsage(env) {
  try {
    const monthStart = getOmanMonthStartISO();
    const dayStart = getOmanDayStartISO();
    const url = new URL(`${trimTrailingSlash(env.SUPABASE_URL)}/rest/v1/api_usage`);
    url.searchParams.set('provider', 'eq.openai');
    url.searchParams.set('created_at', `gte.${monthStart}`);
    url.searchParams.set('status', 'eq.completed');
    url.searchParams.set('select', 'created_at,model,input_tokens,output_tokens,total_tokens,estimated_cost_usd,billed_cost_usd,detail');
    url.searchParams.set('limit', '5000');
    const response = await fetch(url.toString(), { headers: supabaseHeaders(env) });
    if (!response.ok) return { ok: false, error: `Supabase OpenAI usage read failed (${response.status}): ${await limitedText(response)}` };
    const rows = await response.json();
    let monthSpendUsd = 0;
    let todaySpendUsd = 0;
    for (const row of rows || []) {
      // Recalculate Luna rows from token counts using CURRENT official pricing.
      // This also corrects any older Router v1 rows that were logged with the
      // earlier wrong price constants. Prefer billed_cost_usd only when present.
      let cost;
      if (row.billed_cost_usd != null) {
        cost = finiteNonNegativeNumber(row.billed_cost_usd);
      } else if (row.model === OPENAI_MODEL && finiteNonNegativeInteger(row.input_tokens) + finiteNonNegativeInteger(row.output_tokens) > 0) {
        const detail = row.detail && typeof row.detail === 'object' ? row.detail : {};
        cost = calculateLunaCost({
          inputTokens: finiteNonNegativeInteger(row.input_tokens),
          outputTokens: finiteNonNegativeInteger(row.output_tokens),
          totalTokens: finiteNonNegativeInteger(row.total_tokens),
          cachedInputTokens: finiteNonNegativeInteger(detail.cached_input_tokens),
          cacheWriteInputTokens: finiteNonNegativeInteger(detail.cache_write_input_tokens),
          reasoningOutputTokens: finiteNonNegativeInteger(detail.reasoning_output_tokens)
        });
      } else {
        cost = finiteNonNegativeNumber(row.estimated_cost_usd ?? 0);
      }
      monthSpendUsd += cost;
      if (row.created_at && row.created_at >= dayStart) todaySpendUsd += cost;
    }
    return { ok: true, monthSpendUsd, todaySpendUsd };
  } catch (error) {
    return { ok: false, error: safeErrorMessage(error) };
  }
}

async function readGeminiUsageToday(env) {
  try {
    const start = getOmanDayStartISO();

    // 1) Router-recorded Gemini attempts (completed OR failed can consume RPD).
    const usageUrl = new URL(`${trimTrailingSlash(env.SUPABASE_URL)}/rest/v1/api_usage`);
    usageUrl.searchParams.set('provider', 'eq.gemini');
    usageUrl.searchParams.set('created_at', `gte.${start}`);
    usageUrl.searchParams.set('status', 'in.(completed,failed)');
    usageUrl.searchParams.set('select', 'id');
    usageUrl.searchParams.set('limit', '1000');

    // 2) Legacy direct-Gemini activity from the CURRENT transition day.
    // Old Relevance Scorer calls were not written to api_usage. We count only
    // rows with no detail.provider so routed v3 rows are not double-counted.
    const legacyUrl = new URL(`${trimTrailingSlash(env.SUPABASE_URL)}/rest/v1/activity_log`);
    legacyUrl.searchParams.set('worker_name', 'in.("Relevance Scorer","Outreach Writer")');
    legacyUrl.searchParams.set('created_at', `gte.${start}`);
    legacyUrl.searchParams.set('select', 'worker_name,action,detail');
    legacyUrl.searchParams.set('limit', '1000');

    const [usageResponse, legacyResponse] = await Promise.all([
      fetch(usageUrl.toString(), { headers: supabaseHeaders(env) }),
      fetch(legacyUrl.toString(), { headers: supabaseHeaders(env) })
    ]);

    if (!usageResponse.ok) return { ok: false, error: `Supabase Gemini usage read failed (${usageResponse.status}): ${await limitedText(usageResponse)}` };
    if (!legacyResponse.ok) return { ok: false, error: `Supabase legacy Gemini usage read failed (${legacyResponse.status}): ${await limitedText(legacyResponse)}` };

    const usageRows = await usageResponse.json();
    const legacyRows = await legacyResponse.json();
    const legacyRequests = (legacyRows || []).filter(row => {
      const action = String(row?.action || '').toLowerCase();
      const detail = row?.detail && typeof row.detail === 'object' ? row.detail : {};
      return !action.includes('skipped') && !detail.provider;
    }).length;

    return {
      ok: true,
      requestsToday: (Array.isArray(usageRows) ? usageRows.length : 0) + legacyRequests,
      routerRecordedRequests: Array.isArray(usageRows) ? usageRows.length : 0,
      legacyRequests
    };
  } catch (error) {
    return { ok: false, error: safeErrorMessage(error) };
  }
}

function calculateOpenAIDailyPace(usage, monthlyBudgetUsd) {
  const monthRemaining = Math.max(0, monthlyBudgetUsd - usage.monthSpendUsd);
  const daysRemaining = getOmanDaysRemainingInMonth();
  // 20% burst allowance while still recalculating from remaining balance daily.
  const todayAllowanceUsd = Math.min(monthRemaining, (monthRemaining / Math.max(1, daysRemaining)) * 1.20);
  const todayRemainingUsd = Math.max(0, todayAllowanceUsd - usage.todaySpendUsd);
  return { daysRemaining, todayAllowanceUsd, todayRemainingUsd };
}

function estimateMaximumLunaRequestCost(prompt, maxOutputTokens) {
  // Conservative character-to-token estimate plus 15% headroom.
  const estimatedInputTokens = Math.ceil(prompt.length / 3);
  const raw = (estimatedInputTokens / 1_000_000) * LUNA_INPUT_USD_PER_MILLION +
    (maxOutputTokens / 1_000_000) * LUNA_OUTPUT_USD_PER_MILLION;
  return raw * 1.15;
}

function normalizeOpenAIUsage(usage = {}) {
  const inputTokens = finiteNonNegativeInteger(usage.input_tokens);
  const outputTokens = finiteNonNegativeInteger(usage.output_tokens);
  const totalTokens = finiteNonNegativeInteger(usage.total_tokens ?? inputTokens + outputTokens);
  const inputDetails = usage.input_tokens_details || {};
  const outputDetails = usage.output_tokens_details || {};
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    cachedInputTokens: finiteNonNegativeInteger(inputDetails.cached_tokens),
    cacheWriteInputTokens: finiteNonNegativeInteger(inputDetails.cache_write_tokens),
    reasoningOutputTokens: finiteNonNegativeInteger(outputDetails.reasoning_tokens)
  };
}

function normalizeGeminiUsage(usage = {}) {
  const inputTokens = finiteNonNegativeInteger(usage.promptTokenCount);
  const outputTokens = finiteNonNegativeInteger(usage.candidatesTokenCount);
  const totalTokens = finiteNonNegativeInteger(usage.totalTokenCount ?? inputTokens + outputTokens);
  return { inputTokens, outputTokens, totalTokens };
}

function calculateLunaCost(usage) {
  const cached = Math.min(usage.cachedInputTokens, usage.inputTokens);
  const cacheWrite = Math.min(usage.cacheWriteInputTokens, Math.max(0, usage.inputTokens - cached));
  const uncached = Math.max(0, usage.inputTokens - cached - cacheWrite);
  return (
    (uncached / 1_000_000) * LUNA_INPUT_USD_PER_MILLION +
    (cached / 1_000_000) * LUNA_CACHED_INPUT_USD_PER_MILLION +
    (cacheWrite / 1_000_000) * LUNA_CACHE_WRITE_USD_PER_MILLION +
    (usage.outputTokens / 1_000_000) * LUNA_OUTPUT_USD_PER_MILLION
  );
}

async function logUsage(env, row) {
  const safeRow = {
    provider: row.provider,
    model: row.model,
    worker_name: row.worker_name,
    task_type: row.task_type || null,
    provider_request_id: row.provider_request_id || null,
    input_tokens: finiteNonNegativeInteger(row.input_tokens),
    output_tokens: finiteNonNegativeInteger(row.output_tokens),
    total_tokens: finiteNonNegativeInteger(row.total_tokens),
    web_search_calls: 0,
    estimated_cost_usd: roundUsd(row.estimated_cost_usd),
    usage_source: 'actual',
    is_estimated: false,
    status: row.status || 'completed',
    error_code: row.error_code || null,
    detail: row.detail || {}
  };
  try {
    const response = await fetch(`${trimTrailingSlash(env.SUPABASE_URL)}/rest/v1/api_usage`, {
      method: 'POST',
      headers: { ...supabaseHeaders(env), Prefer: 'return=minimal' },
      body: JSON.stringify(safeRow)
    });
    return response.ok ? { ok: true } : { ok: false, error: await limitedText(response) };
  } catch (error) {
    return { ok: false, error: safeErrorMessage(error) };
  }
}

function extractOpenAIOutputText(data) {
  const parts = [];
  for (const item of data?.output || []) {
    if (item?.type !== 'message') continue;
    for (const content of item.content || []) {
      if (content?.type === 'output_text' && typeof content.text === 'string') parts.push(content.text);
    }
  }
  return parts.join('\n').trim();
}

function extractProviderError(data, rawText) {
  const error = data?.error || {};
  return {
    code: cleanString(error.code, 120),
    message: cleanString(error.message, 700) || String(rawText || 'Unknown provider error').slice(0, 700)
  };
}

async function readJsonBody(request) {
  const contentLength = Number(request.headers.get('content-length') || 0);
  if (contentLength > MAX_BODY_CHARS) return { ok: false, status: 413, error: 'Request body is too large.' };
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_CHARS) return { ok: false, status: 413, error: 'Request body is too large.' };
    const value = text ? JSON.parse(text) : {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, status: 400, error: 'JSON body must be an object.' };
    return { ok: true, value };
  } catch (_) {
    return { ok: false, status: 400, error: 'Request body must be valid JSON.' };
  }
}

async function isAuthorized(request, expectedSecret) {
  if (!expectedSecret) return false;
  const provided = request.headers.get('x-router-secret');
  if (!provided) return false;
  const encoder = new TextEncoder();
  const [aHash, bHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(provided)),
    crypto.subtle.digest('SHA-256', encoder.encode(expectedSecret))
  ]);
  const a = new Uint8Array(aHash);
  const b = new Uint8Array(bHash);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function getOmanDayStartISO() {
  const now = new Date();
  const omanNow = new Date(now.getTime() + 4 * 60 * 60 * 1000);
  const midnightFields = Date.UTC(omanNow.getUTCFullYear(), omanNow.getUTCMonth(), omanNow.getUTCDate(), 0, 0, 0);
  return new Date(midnightFields - 4 * 60 * 60 * 1000).toISOString();
}

function getOmanMonthStartISO() {
  const now = new Date();
  const omanNow = new Date(now.getTime() + 4 * 60 * 60 * 1000);
  const monthFields = Date.UTC(omanNow.getUTCFullYear(), omanNow.getUTCMonth(), 1, 0, 0, 0);
  return new Date(monthFields - 4 * 60 * 60 * 1000).toISOString();
}

function getOmanDaysRemainingInMonth() {
  const now = new Date();
  const omanNow = new Date(now.getTime() + 4 * 60 * 60 * 1000);
  const year = omanNow.getUTCFullYear();
  const month = omanNow.getUTCMonth();
  const day = omanNow.getUTCDate();
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return Math.max(1, daysInMonth - day + 1);
}

function supabaseHeaders(env) {
  return {
    apikey: env.SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json'
  };
}

function trimTrailingSlash(value) { return String(value || '').replace(/\/+$/, ''); }
function parseJsonSafely(text) { try { return JSON.parse(text); } catch (_) { return null; } }
function finiteNonNegativeInteger(value) { const n = Number(value); return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0; }
function finiteNonNegativeNumber(value) { const n = Number(value); return Number.isFinite(n) && n >= 0 ? n : 0; }
function roundUsd(value) { return Number(finiteNonNegativeNumber(value).toFixed(8)); }
function cleanString(value, max) { return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null; }
function safeErrorMessage(error) { return error instanceof Error ? error.message.slice(0, 700) : String(error).slice(0, 700); }
async function limitedText(response) { return (await response.text()).slice(0, 700); }
function jsonResponse(status, body) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    }
  });
}
