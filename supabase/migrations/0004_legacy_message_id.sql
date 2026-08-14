-- ============================================================================
-- Store the legacy MESSAGE id instead of the thread id.
--
-- 0003 tried to capture data-legacy-thread-id while a tracked pixel was on
-- screen. It never captured one — 0 of 8 rows — because that attribute does not
-- exist in the thread view at all. Dumping an open thread showed what is there:
--
--   on an ancestor of the pixel   data-legacy-message-id = 19ffe52a40c0cd15
--   elsewhere in the document     data-legacy-thread-id, on LIST rows only,
--                                 none of them containing the pixel
--
-- So the message id is reachable and the thread id is not. That turns out to be
-- enough, because of how Gmail numbers threads: a thread's id is the id of its
-- FIRST message. Visible in the same dump — most list rows carry an identical
-- data-legacy-thread-id and data-legacy-last-message-id (single-message
-- threads), while a multi-message thread shows 19ff8cee1ca12285 against a last
-- message of 19fffffc1b8343ab.
--
-- Which means a list row can be matched on either attribute:
--
--   message started the thread   its id == the row's data-legacy-thread-id
--   message is a newer reply     its id == the row's data-legacy-last-message-id
--
-- Between them those cover a sent message that began a thread, and a reply that
-- is still the newest in one. A reply that has since been replied to matches
-- neither, and stays unbadged in the list — the in-thread badge is unaffected.
--
-- Renamed rather than added alongside: legacy_thread_id was never populated, so
-- keeping it would leave a permanently null column inviting the question of why.
-- ============================================================================

alter table public.messages rename column legacy_thread_id to legacy_message_id;

drop index if exists public.messages_legacy_thread_idx;
create index if not exists messages_legacy_message_idx
  on public.messages (user_id, legacy_message_id);

drop function if exists public.note_self_view(text, text, text);

create or replace function public.note_self_view(
  p_token             text,
  p_thread_id         text default null,
  p_legacy_message_id text default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  m record;
begin
  select id, user_id, thread_id, legacy_message_id into m
  from public.messages where token = p_token;

  if not found or m.user_id is distinct from auth.uid() then
    return;  -- not yours: say nothing, reveal nothing
  end if;

  if (p_thread_id is not null and m.thread_id is distinct from p_thread_id)
     or (p_legacy_message_id is not null
         and m.legacy_message_id is distinct from p_legacy_message_id) then
    update public.messages
       set thread_id         = coalesce(p_thread_id, thread_id),
           legacy_message_id = coalesce(p_legacy_message_id, legacy_message_id)
     where id = m.id;
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

revoke execute on function public.note_self_view(text, text, text) from public, anon;
grant  execute on function public.note_self_view(text, text, text) to authenticated;

-- Dropped and recreated, not replaced: CREATE OR REPLACE VIEW cannot rename an
-- output column, and this one's last column changes name with the table's.
drop view if exists public.message_stats;

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
  coalesce(c.click_count, 0)                                 as click_count,
  m.legacy_message_id
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
