import { supabase } from './supabaseClient.js';

const sectionForPage = {
  prospects: 'business', contacts: 'business', partners: 'business', pipeline: 'business',
  drafts: 'outreach', conversations: 'outreach', followups: 'outreach',
  console: 'system', usage: 'system', activity: 'system', settings: 'system'
};

function currentPage() {
  const path = location.pathname.split('/').filter(Boolean).pop() || 'dashboard';
  return path.replace(/\.html$/i, '') || 'dashboard';
}

function setOpen(sectionName, remember = true) {
  document.querySelectorAll('[data-nav-section]').forEach(section => {
    const open = section.dataset.navSection === sectionName;
    section.classList.toggle('open', open);
    const button = section.querySelector('.nav-group-toggle');
    if (button) button.setAttribute('aria-expanded', String(open));
  });
  if (remember) {
    if (sectionName) localStorage.setItem('ylo-nav-open-section', sectionName);
    else localStorage.removeItem('ylo-nav-open-section');
  }
}

function initNav() {
  const page = currentPage();
  document.querySelectorAll('[data-nav-page]').forEach(link => {
    link.classList.toggle('active', link.dataset.navPage === page);
  });

  const activeSection = sectionForPage[page];
  const remembered = localStorage.getItem('ylo-nav-open-section');
  if (activeSection) setOpen(activeSection, false);
  else if (remembered && document.querySelector(`[data-nav-section="${remembered}"]`)) setOpen(remembered, false);
  else setOpen(null, false);

  document.querySelectorAll('.nav-group-toggle').forEach(button => {
    button.addEventListener('click', () => {
      const section = button.closest('[data-nav-section]');
      const name = section?.dataset.navSection;
      const alreadyOpen = section?.classList.contains('open');
      setOpen(alreadyOpen ? null : name);
    });
  });
}

async function countRows(table, apply) {
  try {
    let q = supabase.from(table).select('*', { count: 'exact', head: true });
    if (apply) q = apply(q);
    const { count, error } = await q;
    return error ? null : (count ?? 0);
  } catch (_) { return null; }
}

function showCount(name, value) {
  const el = document.querySelector(`[data-nav-count="${name}"]`);
  if (!el || value == null) return;
  if (value <= 0) { el.hidden = true; return; }
  el.textContent = value > 99 ? '99+' : String(value);
  el.hidden = false;
}

async function loadNavCounts() {
  try { await supabase.auth.getSession(); } catch (_) {}
  const now = new Date().toISOString();
  const [drafts, conversations, followups] = await Promise.all([
    countRows('email_drafts', q => q.eq('status', 'draft')),
    countRows('outreach_conversations', q => q.eq('status', 'active')),
    countRows('outreach_conversations', q => q.eq('status', 'active').not('next_follow_up_at', 'is', null).lte('next_follow_up_at', now))
  ]);
  showCount('drafts', drafts);
  showCount('conversations', conversations);
  showCount('followups', followups);
}

initNav();
loadNavCounts();
