-- ============================================================================
-- Narrow the self-view windows.
--
-- Observed in use: a genuine open from a phone was logged correctly as 'open',
-- then flipped to 'self' seconds later. Cause was the reach-back in
-- note_self_view, which rewrote anything in the previous 20 seconds every time
-- the extension reported the sender was looking. Since the extension reported
-- that every few seconds for as long as the thread was on screen, the rewrite
-- window slid forward continuously and swallowed real opens.
--
-- Two changes, here and in the extension:
--
--   1. The extension now claims a self-view ONCE per render rather than
--      continuously, because Gmail fetches a pixel once when the message
--      renders and not again while you read it.
--   2. The windows below shrink to match that single moment: 20s -> 8s of
--      reach-back, 25s -> 10s of forward suppression.
--
-- Together these mean a recipient opening your mail while you happen to have
-- the thread on screen is now counted, where before it was silently erased.
--
-- Existing rows are left alone. A 'self' row recorded under the old rule can't
-- be distinguished after the fact from a genuine one, so re-labelling history
-- would be guessing.
-- ============================================================================

create or replace function public.note_self_view(p_token text, p_thread_id text default null)
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

  -- Reach back only far enough to cover the gap between Google's proxy fetch
  -- and the extension noticing the render. Anything older is somebody else.
  update public.opens
     set classification = 'self',
         reason         = 'sender had the thread open'
   where message_id = m.id
     and opened_at  > now() - interval '8 seconds'
     and classification in ('open', 'prefetch');
end;
$$;

create or replace function public.record_open(
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
                  and s.seen_at > now() - interval '10 seconds') then
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
