-- ============================================================================
-- Kilroy — initial schema
--
-- Ownership model: every row belongs to an auth.users row. RLS lets a signed-in
-- user read and write only their own data. The public pixel/redirect endpoints
-- run as service_role (which bypasses RLS) and reach the tables only through
-- the two SECURITY DEFINER functions at the bottom of this file.
-- ============================================================================

-- ---------------------------------------------------------------- messages --
-- One row per tracked outgoing email. Created when a compose window opens
-- (status 'draft'), promoted to 'sent' when the send actually goes through.
create table public.messages (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  token       text not null unique,
  status      text not null default 'draft' check (status in ('draft', 'sent')),
  subject     text,
  recipients  text[] not null default '{}',
  thread_id   text,
  sent_at     timestamptz,
  created_at  timestamptz not null default now()
);

create index messages_user_sent_idx   on public.messages (user_id, sent_at desc nulls last);
create index messages_thread_idx      on public.messages (user_id, thread_id);
create index messages_draft_purge_idx on public.messages (created_at) where status = 'draft';

-- ------------------------------------------------------------------- opens --
-- classification:
--   open     — believed to be a genuine human open
--   prefetch — machine fetch (Apple MPP, security scanner, or inside the
--              post-send grace window where the sender's own client is fetching)
--   self     — the sender was demonstrably viewing the thread at that moment
--   dup      — collapsed into an immediately preceding hit
create table public.opens (
  id             bigint generated always as identity primary key,
  message_id     uuid not null references public.messages (id) on delete cascade,
  opened_at      timestamptz not null default now(),
  user_agent     text,
  ip             inet,
  proxy          text,
  classification text not null default 'open'
                 check (classification in ('open', 'prefetch', 'self', 'dup')),
  reason         text
);

create index opens_message_idx on public.opens (message_id, opened_at desc);

-- ------------------------------------------------------------------- links --
-- Registered by the extension while you compose, so the redirect endpoint never
-- has to trust a URL handed to it by the caller. No registration => no redirect.
create table public.links (
  id          uuid primary key default gen_random_uuid(),
  message_id  uuid not null references public.messages (id) on delete cascade,
  token       text not null unique,
  target_url  text not null,
  label       text,
  created_at  timestamptz not null default now()
);

create table public.link_clicks (
  id             bigint generated always as identity primary key,
  link_id        uuid not null references public.links (id) on delete cascade,
  clicked_at     timestamptz not null default now(),
  user_agent     text,
  ip             inet,
  classification text not null default 'open'
                 check (classification in ('open', 'prefetch', 'self', 'dup')),
  reason         text
);

create index link_clicks_link_idx on public.link_clicks (link_id, clicked_at desc);

-- -------------------------------------------------------------- self_views --
-- Heartbeat the extension posts while YOU have a tracked thread on screen in
-- Gmail. Your own client fetching the pixel from the Sent copy is the single
-- largest source of false positives; this is how we cancel it out.
create table public.self_views (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references auth.users (id) on delete cascade,
  message_id uuid references public.messages (id) on delete cascade,
  thread_id  text,
  seen_at    timestamptz not null default now()
);

create index self_views_lookup_idx on public.self_views (message_id, seen_at desc);

-- ================================================================= row-level =
alter table public.messages    enable row level security;
alter table public.opens       enable row level security;
alter table public.links       enable row level security;
alter table public.link_clicks enable row level security;
alter table public.self_views  enable row level security;

create policy messages_own on public.messages
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy self_views_own on public.self_views
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy links_own on public.links
  for all to authenticated
  using (exists (select 1 from public.messages m
                 where m.id = links.message_id and m.user_id = auth.uid()))
  with check (exists (select 1 from public.messages m
                      where m.id = links.message_id and m.user_id = auth.uid()));

-- Opens and clicks are written only by the endpoints. Users read, never write.
create policy opens_own_read on public.opens
  for select to authenticated
  using (exists (select 1 from public.messages m
                 where m.id = opens.message_id and m.user_id = auth.uid()));

create policy link_clicks_own_read on public.link_clicks
  for select to authenticated
  using (exists (select 1 from public.links l
                 join public.messages m on m.id = l.message_id
                 where l.id = link_clicks.link_id and m.user_id = auth.uid()));

-- ===================================================================== view =
-- Everything the dashboard and the Gmail badges need, in one read.
-- security_invoker keeps the caller's RLS in force.
create view public.message_stats
with (security_invoker = on) as
select
  m.id,
  m.token,
  m.subject,
  m.recipients,
  m.thread_id,
  m.sent_at,
  count(o.id) filter (where o.classification = 'open')       as open_count,
  min(o.opened_at) filter (where o.classification = 'open')  as first_open_at,
  max(o.opened_at) filter (where o.classification = 'open')  as last_open_at,
  count(o.id) filter (where o.classification = 'prefetch')   as prefetch_count,
  coalesce(c.click_count, 0)                                 as click_count
from public.messages m
left join public.opens o on o.message_id = m.id
left join lateral (
  select count(*) as click_count
  from public.link_clicks lc
  join public.links l on l.id = lc.link_id
  where l.message_id = m.id and lc.classification = 'open'
) c on true
where m.status = 'sent'
group by m.id, c.click_count;

-- ================================================================ endpoints =

-- Called by the px Edge Function. Classifies the hit before storing it, in one
-- round trip, so two near-simultaneous fetches can't both be counted.
create function public.record_open(
  p_token       text,
  p_user_agent  text,
  p_ip          text,
  p_proxy       text,
  p_ua_prefetch boolean default false
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  m       record;
  v_class text;
  v_why   text;
begin
  select id, sent_at, created_at into m
  from public.messages
  where token = p_token and status = 'sent';

  if not found then
    return;  -- unknown or unsent token: log nothing, still serve the pixel
  end if;

  if exists (select 1 from public.opens o
             where o.message_id = m.id
               and o.opened_at > now() - interval '15 seconds') then
    v_class := 'dup';
    v_why   := 'collapsed into a hit less than 15s old';

  elsif exists (select 1 from public.self_views s
                where s.message_id = m.id
                  and s.seen_at > now() - interval '25 seconds') then
    v_class := 'self';
    v_why   := 'sender had the thread open';

  elsif p_ua_prefetch then
    v_class := 'prefetch';
    v_why   := 'scanner or prefetcher user-agent';

  elsif coalesce(m.sent_at, m.created_at) > now() - interval '45 seconds' then
    v_class := 'prefetch';
    v_why   := 'arrived within 45s of send';

  else
    v_class := 'open';
  end if;

  insert into public.opens (message_id, user_agent, ip, proxy, classification, reason)
  values (m.id, p_user_agent, p_ip::inet, p_proxy, v_class, v_why);
exception
  when others then
    -- A tracking pixel must never fail loudly. Swallow and move on.
    return;
end;
$$;

-- Called by the r Edge Function. Returns the URL to redirect to, or null if the
-- token was never registered — which is what stops this being an open redirect.
create function public.record_click(
  p_token      text,
  p_user_agent text,
  p_ip         text
) returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  l       record;
  v_class text;
  v_why   text;
begin
  select id, target_url, message_id into l from public.links where token = p_token;
  if not found then
    return null;
  end if;

  if exists (select 1 from public.self_views s
             where s.message_id = l.message_id
               and s.seen_at > now() - interval '25 seconds') then
    v_class := 'self';
    v_why   := 'sender had the thread open';
  else
    v_class := 'open';
  end if;

  insert into public.link_clicks (link_id, user_agent, ip, classification, reason)
  values (l.id, p_user_agent, p_ip::inet, v_class, v_why);

  return l.target_url;
exception
  when others then
    return l.target_url;  -- always complete the redirect
end;
$$;

revoke execute on function public.record_open(text, text, text, text, boolean)
  from public, anon, authenticated;
revoke execute on function public.record_click(text, text, text)
  from public, anon, authenticated;
grant execute on function public.record_open(text, text, text, text, boolean) to service_role;
grant execute on function public.record_click(text, text, text)               to service_role;

-- Called by the extension when it spots one of your own tracking pixels in a
-- thread you currently have on screen. Your Gmail fetches that pixel exactly
-- like a recipient's would, so without this every time you reread your own Sent
-- mail it registers as an open.
--
-- The update clause matters as much as the insert: Google's proxy fetch often
-- lands a beat before the extension notices the thread rendered, so we also
-- reach back and reclassify anything logged in the last few seconds.
-- p_thread_id lets Kilroy learn thread IDs for free: a brand-new compose has no
-- thread yet, but the first time you open the sent thread we see our own pixel
-- and the URL together, and can backfill it.
create function public.note_self_view(p_token text, p_thread_id text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  m record;
begin
  select id, user_id, thread_id into m from public.messages where token = p_token;
  if not found or m.user_id is distinct from auth.uid() then
    return;  -- not yours: say nothing, reveal nothing
  end if;

  if p_thread_id is not null and m.thread_id is distinct from p_thread_id then
    update public.messages set thread_id = p_thread_id where id = m.id;
  end if;

  insert into public.self_views (user_id, message_id, thread_id)
  values (m.user_id, m.id, coalesce(p_thread_id, m.thread_id));

  update public.opens
     set classification = 'self',
         reason         = 'sender had the thread open'
   where message_id = m.id
     and opened_at  > now() - interval '20 seconds'
     and classification in ('open', 'prefetch');
end;
$$;

revoke execute on function public.note_self_view(text, text) from public, anon;
grant  execute on function public.note_self_view(text, text) to authenticated;

-- Compose windows you opened and then abandoned leave 'draft' rows behind.
-- Call this occasionally, or schedule it with pg_cron (see docs/SETUP.md).
create function public.purge_stale_drafts() returns integer
language sql
security definer
set search_path = public
as $$
  with gone as (
    delete from public.messages
    where status = 'draft' and created_at < now() - interval '7 days'
    returning 1
  )
  select count(*)::integer from gone;
$$;
