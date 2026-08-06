-- Yachts Logistics OS — Conversations + follow-up workspace
-- Run ONCE in Supabase SQL Editor before using conversations.html.
-- This does not delete or replace the older replies/follow_ups tables.
-- It creates a clean, known schema for the manual-review conversation workflow.

create extension if not exists pgcrypto;

create table if not exists public.outreach_conversations (
  id uuid primary key default gen_random_uuid(),
  prospect_id uuid not null references public.prospects(id) on delete cascade,
  draft_id text,
  status text not null default 'active'
    check (status in ('active','closed','won','lost')),
  started_at timestamptz not null default now(),
  last_activity_at timestamptz not null default now(),
  last_inbound_at timestamptz,
  last_outbound_at timestamptz,
  next_follow_up_at timestamptz,
  follow_up_count integer not null default 0 check (follow_up_count >= 0),
  close_after_at timestamptz not null default (now() + interval '42 days'),
  closed_at timestamptz,
  close_reason text,
  unique (prospect_id)
);

create table if not exists public.outreach_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.outreach_conversations(id) on delete cascade,
  prospect_id uuid not null references public.prospects(id) on delete cascade,
  direction text not null check (direction in ('inbound','outbound')),
  message_type text not null
    check (message_type in ('initial_sent','reply_received','ai_reply_draft','ai_follow_up_draft','manual_note')),
  subject text,
  body text not null,
  status text not null default 'saved'
    check (status in ('saved','draft','approved','sent')),
  ai_status text not null default 'none'
    check (ai_status in ('none','pending','ready','processed')),
  provider text,
  model text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

create index if not exists outreach_conversations_status_idx
  on public.outreach_conversations(status, next_follow_up_at);
create index if not exists outreach_messages_conversation_idx
  on public.outreach_messages(conversation_id, created_at);
create index if not exists outreach_messages_ai_status_idx
  on public.outreach_messages(ai_status, created_at);

create unique index if not exists outreach_messages_one_initial_idx
  on public.outreach_messages(conversation_id)
  where message_type = 'initial_sent';

alter table public.outreach_conversations enable row level security;
alter table public.outreach_messages enable row level security;

drop policy if exists "Authenticated users manage outreach conversations" on public.outreach_conversations;
create policy "Authenticated users manage outreach conversations"
  on public.outreach_conversations for all to authenticated
  using (true) with check (true);

drop policy if exists "Authenticated users manage outreach messages" on public.outreach_messages;
create policy "Authenticated users manage outreach messages"
  on public.outreach_messages for all to authenticated
  using (true) with check (true);

revoke all on public.outreach_conversations from anon;
revoke all on public.outreach_messages from anon;
grant select, insert, update, delete on public.outreach_conversations to authenticated;
grant select, insert, update, delete on public.outreach_messages to authenticated;
