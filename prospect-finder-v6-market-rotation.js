// Yachts Logistics OS — Conversation Manager v1.0
//
// Manual-review-first reply + follow-up assistant. NEVER sends email.
//
// What it does on each run:
// 1) Checks for replies the owner pasted into Conversations.
// 2) Checks for conversations whose follow-up date is due.
// 3) If there is work, batches up to 5 items into ONE AI Router request.
// 4) Saves suggested replies/follow-ups as drafts for human editing/approval.
// 5) If a prospect never replied at all, automatically closes the conversation
//    after 42 days. Conversations that have received any reply are never auto-closed.
//
// Empty scheduled runs stop before the AI Router and use ZERO OpenAI/Gemini requests.
//
// Required variables/secrets:
//   AI_ROUTER_URL, ROUTER_SECRET, SUPABASE_URL, SUPABASE_SERVICE_KEY, WORKER_SECRET
//
// Suggested Cron AFTER one dry + live test:
//   15 */6 * * *

const DEFAULT_BATCH_SIZE = 5;
const MAX_BATCH_SIZE = 6;

export default {
  async fetch(request, env) {
    const providedSecret = request.headers.get('x-worker-secret');
    if (!env.WORKER_SECRET || providedSecret !== env.WORKER_SECRET) {
      return jsonResponse(401, { error: 'Missing or incorrect x-worker-secret header.' });
    }
    const url = new URL(request.url);
    const requested = Number.parseInt(url.searchParams.get('batch') || String(DEFAULT_BATCH_SIZE), 10);
    const batchSize = Number.isFinite(requested) ? Math.max(1, Math.min(requested, MAX_BATCH_SIZE)) : DEFAULT_BATCH_SIZE;
    const isLive = url.searchParams.get('live') === 'true';
    const result = await runManager(env, batchSize, isLive);
    return jsonResponse(result.status, result.body);
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runManager(env, DEFAULT_BATCH_SIZE, true));
  }
};

async function runManager(env, batchSize, isLive) {
  const missing = ['AI_ROUTER_URL','ROUTER_SECRET','SUPABASE_URL','SUPABASE_SERVICE_KEY'].filter(k => !env[k]);
  if (missing.length) return { status:500, body:{ error:'Missing Worker variables.', missing } };

  const headers = {
    apikey: env.SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
    'Content-Type':'application/json'
  };

  try {
    const now = new Date();
    const nowIso = now.toISOString();
    const [conversations, messages, prospects, profile] = await Promise.all([
      fetchRows(`${env.SUPABASE_URL}/rest/v1/outreach_conversations?status=eq.active&select=*&order=last_activity_at.asc&limit=500`, headers),
      fetchRows(`${env.SUPABASE_URL}/rest/v1/outreach_messages?select=*&order=created_at.asc&limit=3000`, headers),
      fetchRows(`${env.SUPABASE_URL}/rest/v1/prospects?select=id,company_name,country,business_type,relevance_reason,website&limit=2000`, headers),
      fetchRows(`${env.SUPABASE_URL}/rest/v1/company_profile?select=*&limit=1`, headers)
    ]);

    for (const r of [conversations,messages,prospects]) {
      if (!r.ok) return { status:500, body:{ error:r.error } };
    }

    const convs = conversations.rows || [];
    const msgs = messages.rows || [];
    const prospectMap = new Map((prospects.rows || []).map(p => [String(p.id), p]));
    const msgsByConv = new Map();
    for (const m of msgs) {
      if (!msgsByConv.has(m.conversation_id)) msgsByConv.set(m.conversation_id, []);
      msgsByConv.get(m.conversation_id).push(m);
    }

    // Auto-close only prospects who never replied at all and have reached six weeks.
    const expiring = convs.filter(c => !c.last_inbound_at && c.close_after_at && new Date(c.close_after_at) <= now);
    if (isLive) {
      for (const c of expiring) {
        await patchRow(env.SUPABASE_URL, headers, 'outreach_conversations', c.id, {
          status:'closed', closed_at:nowIso, close_reason:'no_response_6_weeks', last_activity_at:nowIso, next_follow_up_at:null
        });
        await patchRow(env.SUPABASE_URL, headers, 'prospects', c.prospect_id, { status:'lost', updated_at:nowIso });
      }
    }
    const expiredIds = new Set(expiring.map(c => c.id));

    const tasks = [];

    // Replies always take priority over follow-ups.
    for (const c of convs) {
      if (expiredIds.has(c.id) || tasks.length >= batchSize) continue;
      const thread = msgsByConv.get(c.id) || [];
      const pending = thread.filter(m => m.direction === 'inbound' && m.ai_status === 'pending');
      if (!pending.length) continue;
      const inbound = pending[pending.length - 1];
      const hasReplyDraft = thread.some(m => m.message_type === 'ai_reply_draft' && ['draft','approved'].includes(m.status) && new Date(m.created_at) >= new Date(inbound.created_at));
      if (hasReplyDraft) continue;
      tasks.push(makeTask('reply', c, inbound, thread, prospectMap.get(String(c.prospect_id))));
    }

    // Then use remaining batch space for due follow-ups.
    for (const c of convs) {
      if (expiredIds.has(c.id) || tasks.length >= batchSize) continue;
      if (!c.next_follow_up_at || new Date(c.next_follow_up_at) > now) continue;
      if (Number(c.follow_up_count || 0) >= 3) continue;
      if (tasks.some(t => t.conversation_id === c.id)) continue;
      const thread = msgsByConv.get(c.id) || [];
      const outstanding = thread.some(m => m.message_type === 'ai_follow_up_draft' && ['draft','approved'].includes(m.status));
      if (outstanding) continue;
      // Only follow up if we are waiting on them: no inbound after our latest sent message.
      const latestSent = [...thread].reverse().find(m => m.direction === 'outbound' && m.status === 'sent');
      const latestInbound = [...thread].reverse().find(m => m.direction === 'inbound');
      if (!latestSent) continue;
      if (latestInbound && new Date(latestInbound.created_at) > new Date(latestSent.sent_at || latestSent.created_at)) continue;
      tasks.push(makeTask('follow_up', c, latestSent, thread, prospectMap.get(String(c.prospect_id))));
    }

    if (!tasks.length) {
      const reason = `No pasted replies or due follow-ups need an AI draft right now.${expiring.length ? ` ${expiring.length} no-response conversation(s) ${isLive ? 'were closed' : 'would be closed'} at six weeks.` : ''}`;
      await logActivity(env.SUPABASE_URL, headers, `Conversation Manager check — ${reason}`, { live:isLive, ai_call_made:false, expired:expiring.length });
      return { status:200, body:{ drafted:0, ai_call_made:false, expired:expiring.length, reason } };
    }

    const companyProfile = profile.ok ? (profile.rows?.[0] || {}) : {};
    const prompt = buildPrompt(companyProfile, tasks);
    const routed = await callRouter(env, {
      // Router v2 currently accepts this task type. We keep routing changes minimal.
      task_type:'outreach_draft',
      worker_name:'Conversation Manager',
      prompt,
      max_output_tokens:3200
    });

    if (!routed.ok) {
      await logActivity(env.SUPABASE_URL, headers, 'Conversation Manager failed — AI Router error.', { live:isLive, error:clip(routed.error,1000), router:routed.data || null });
      return { status:routed.status === 429 ? 200 : 502, body:routed.status === 429 ? { skipped:true, reason:routed.error } : { error:routed.error } };
    }

    const parsed = parseArray(routed.output);
    if (!parsed.ok) return { status:502, body:{ error:parsed.error, provider:routed.provider, raw:clip(routed.output,1000) } };

    const taskMap = new Map(tasks.map(t => [t.task_id,t]));
    const accepted = [], rejected = [];
    for (const row of parsed.rows) {
      const taskId = clean(row.task_id,160);
      const subject = clean(row.subject,240);
      const body = clean(row.body,9000);
      if (!taskId || !taskMap.has(taskId)) { rejected.push({task_id:taskId,reason:'Unknown task_id'}); continue; }
      if (!subject || !body) { rejected.push({task_id:taskId,reason:'Missing subject/body'}); continue; }
      accepted.push({ task:taskMap.get(taskId), subject, body });
    }

    if (!isLive) {
      await logActivity(env.SUPABASE_URL, headers, `Conversation Manager dry run via ${routed.provider} — ${accepted.length} suggestion(s), nothing written.`, { live:false, ai_call_made:true, provider:routed.provider, tasks:accepted.map(a=>a.task.task_id), rejected });
      return { status:200, body:{ mode:'DRY RUN — nothing written.', provider:routed.provider, model:routed.model, fallback_used:routed.fallback_used, drafted:accepted.length, results:accepted.map(a=>({task_id:a.task.task_id,type:a.task.type,company_name:a.task.company_name,subject:a.subject,body:a.body})), rejected } };
    }

    const results = [], failures = [];
    for (const a of accepted) {
      const t = a.task;
      const messageType = t.type === 'reply' ? 'ai_reply_draft' : 'ai_follow_up_draft';
      const insert = await postRow(env.SUPABASE_URL, headers, 'outreach_messages', {
        conversation_id:t.conversation_id,
        prospect_id:t.prospect_id,
        direction:'outbound',
        message_type:messageType,
        subject:a.subject,
        body:a.body,
        status:'draft',
        ai_status:'ready',
        provider:routed.provider,
        model:routed.model
      });
      if (!insert.ok) { failures.push({task_id:t.task_id,error:insert.error}); continue; }

      if (t.type === 'reply' && t.source_message_id) {
        await patchRow(env.SUPABASE_URL, headers, 'outreach_messages', t.source_message_id, { ai_status:'processed' });
      }
      await patchRow(env.SUPABASE_URL, headers, 'outreach_conversations', t.conversation_id, { last_activity_at:nowIso });
      results.push({ task_id:t.task_id, type:t.type, company_name:t.company_name, subject:a.subject });
    }

    await logActivity(env.SUPABASE_URL, headers, `Conversation Manager complete via ${routed.provider} — created ${results.length} suggested response/follow-up draft(s); nothing sent.`, { live:true, provider:routed.provider, model:routed.model, fallback_used:routed.fallback_used, results, failures, rejected, expired:expiring.length });
    return { status:200, body:{ mode:'LIVE — suggestions saved. Nothing sent.', provider:routed.provider, model:routed.model, fallback_used:routed.fallback_used, drafted:results.length, results, failures, rejected, expired:expiring.length } };
  } catch (error) {
    return { status:500, body:{ error:clip(error?.message || error,1200) } };
  }
}

function makeTask(type, c, sourceMessage, thread, prospect) {
  const history = thread.slice(-8).map(m => ({
    direction:m.direction,
    type:m.message_type,
    status:m.status,
    subject:clip(m.subject || '',300),
    body:clip(m.body || '',2500),
    at:m.sent_at || m.created_at
  }));
  return {
    task_id:`${type}:${c.id}:${sourceMessage.id}`,
    type,
    conversation_id:c.id,
    prospect_id:c.prospect_id,
    source_message_id:sourceMessage.id,
    company_name:prospect?.company_name || 'Unknown company',
    country:prospect?.country || null,
    business_type:prospect?.business_type || null,
    relevance_reason:prospect?.relevance_reason || null,
    follow_up_number:Number(c.follow_up_count || 0) + 1,
    history
  };
}

function buildPrompt(profile, tasks) {
  const signature = clean(profile?.signature,2500) || 'Best regards,\nSaeed Awad Almaqbali\nCo-Owner\nYachts Logistics';
  const services = Array.isArray(profile?.services) ? profile.services.join(', ') : '';
  return `
You draft business EMAIL RESPONSES and FOLLOW-UPS for Yachts Logistics, Oman.
These are human-review drafts only. Nothing is sent automatically.

YACHTS LOGISTICS FACTS:
Services: ${services || 'Use only facts already present in the conversation.'}
Required signature:\n${signature}

RULES FOR REPLY TASKS:
- Read the complete supplied thread so you understand why Yachts Logistics contacted this exact company and what they replied.
- Answer the substance of THEIR latest reply. Do not restart the original introduction unless context genuinely requires it.
- If they ask a question that cannot be answered from supplied facts (rates, exact availability, technical details, dates, documents, etc.), do not invent an answer. Acknowledge it and ask for the necessary details or say the team can prepare/confirm the requirement.
- Match their tone professionally. Be clear, warm and businesslike.
- Do not claim an email was sent, a quotation attached, a booking confirmed, or an arrangement completed unless the thread says so.

RULES FOR FOLLOW_UP TASKS:
- This company has not replied since our latest sent message.
- Write a concise, natural follow-up. Do NOT paste/rewrite the full first introduction.
- Politely bring the earlier message back to their attention, restate the relevant cooperation value in one short line, and invite them to share any Oman requirement.
- Follow-up #1 can be gentle; later follow-ups may be slightly more direct but never pushy or spammy.

GENERAL:
- Keep the existing subject as "Re: ..." when sensible; do not invent a fake new topic.
- Use the company name naturally where helpful.
- Never invent people, vessels, prices, port calls, clients, guarantees or past relationships.
- Include the supplied signature.
- Return ONLY valid JSON, one object per task.

FORMAT:
[
  {"task_id":"copy exact task_id","subject":"subject","body":"complete email draft"}
]

TASKS:
${JSON.stringify(tasks,null,2)}
`.trim();
}

async function callRouter(env,payload){
  try{
    const r=await fetch(`${String(env.AI_ROUTER_URL).replace(/\/+$/,'')}/generate`,{method:'POST',headers:{'Content-Type':'application/json','x-router-secret':env.ROUTER_SECRET},body:JSON.stringify(payload)});
    const text=await r.text(); let data=null; try{data=JSON.parse(text)}catch(_){}
    if(!r.ok || !data?.ok) return {ok:false,status:r.status,error:data?.error || clip(text,1000),data};
    return {ok:true,provider:data.provider,model:data.model,output:data.output || '',fallback_used:Boolean(data.fallback_used)};
  }catch(e){return {ok:false,status:502,error:`Could not reach AI Router: ${e.message || e}`};}
}
async function fetchRows(url,headers){try{const r=await fetch(url,{headers});if(!r.ok)return{ok:false,error:clip(await r.text(),1000)};return{ok:true,rows:await r.json()}}catch(e){return{ok:false,error:String(e)}}}
async function postRow(base,headers,table,row){const r=await fetch(`${base}/rest/v1/${table}`,{method:'POST',headers:{...headers,Prefer:'return=minimal'},body:JSON.stringify(row)});return r.ok?{ok:true}:{ok:false,error:clip(await r.text(),1000)}}
async function patchRow(base,headers,table,id,patch){const r=await fetch(`${base}/rest/v1/${table}?id=eq.${encodeURIComponent(id)}`,{method:'PATCH',headers:{...headers,Prefer:'return=minimal'},body:JSON.stringify(patch)});return r.ok?{ok:true}:{ok:false,error:clip(await r.text(),1000)}}
async function logActivity(base,headers,action,detail){try{await fetch(`${base}/rest/v1/activity_log`,{method:'POST',headers:{...headers,Prefer:'return=minimal'},body:JSON.stringify({worker_name:'Conversation Manager',action,target_table:'outreach_messages',detail:detail||{}})})}catch(_){}}
function parseArray(raw){const c=String(raw||'').replace(/```json/gi,'').replace(/```/g,'').trim();const a=c.indexOf('['),b=c.lastIndexOf(']');if(a<0||b<=a)return{ok:false,error:'AI did not return a JSON array.'};try{const rows=JSON.parse(c.slice(a,b+1));return Array.isArray(rows)?{ok:true,rows}:{ok:false,error:'AI output was not an array.'}}catch(e){return{ok:false,error:`Invalid JSON: ${e.message}`}}}
function clean(v,max){return typeof v==='string'&&v.trim()?v.trim().slice(0,max):null}
function clip(v,max){return String(v||'').slice(0,max)}
function jsonResponse(status,body){return new Response(JSON.stringify(body,null,2),{status,headers:{'Content-Type':'application/json'}})}
