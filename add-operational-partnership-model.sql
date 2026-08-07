import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = 'https://kitnjehdopdlpbwhzqch.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_e5c-VAm7qsSqGqBL10g0PQ_MroOGdlU';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Redirects to login if not authenticated. Call at the top of every
// protected page. Returns the logged-in user if there is one.
export async function requireAuth() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    window.location.href = 'index.html';
    return null;
  }
  const emailEl = document.querySelector('[data-user-email]');
  if (emailEl) emailEl.textContent = session.user.email;
  return session.user;
}

export function wireSignOut() {
  const btn = document.querySelector('[data-signout]');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    await supabase.auth.signOut();
    window.location.href = 'index.html';
  });
}

// Writes one row to activity_log. Never throws — logging should never
// break the action that triggered it.
export async function logActivity(workerName, action, targetTable, targetId, detail) {
  try {
    await supabase.from('activity_log').insert({
      worker_name: workerName,
      action,
      target_table: targetTable,
      target_id: targetId || null,
      detail: detail || {}
    });
  } catch (e) {
    console.warn('activity log write failed', e);
  }
}

export const STATUS_ORDER = [
  'discovered', 'researched', 'draft_ready', 'approved', 'contacted',
  'follow_up_due', 'replied', 'meeting', 'quotation', 'won', 'lost'
];

export const STATUS_LABELS = {
  discovered: 'Discovered',
  researched: 'Researched',
  draft_ready: 'Draft Ready',
  approved: 'Approved',
  contacted: 'Contacted',
  follow_up_due: 'Follow-up Due',
  replied: 'Replied',
  meeting: 'Meeting',
  quotation: 'Quotation',
  won: 'Won',
  lost: 'Lost'
};

export function statusBadge(status) {
  const s = status || 'discovered';
  const label = STATUS_LABELS[s] || s;
  return `<span class="badge badge-${s}">${label}</span>`;
}

export function timeAgo(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString('en-US', {
    timeZone: 'Asia/Muscat',
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true
  }) + ' Oman time';
}
