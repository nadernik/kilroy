-- ============================================================================
-- Learn Gmail's legacy thread id, so badges can reach the thread LIST.
--
-- Gmail uses three ids for the same thread and only two of them are related:
--
--   URL hash            QgrcJHrttkVDPRCsHzDVMMnxnTfspNKdwtl   opaque permalink
--   data-thread-id      #thread-f:1873504067903193175         decimal
--   data-legacy-thread-id  1a000606049e8057                   the same, in hex
--
-- The last two are one number in two bases. The permalink is not derivable from
-- either, and it is the one that appears in the URL — so what note_self_view has
-- been storing can never be matched against a list row. Badges in the list need
-- the legacy id captured separately.
--
-- Consequence worth knowing: the id is learned the first time you view a thread
-- after sending, because that is when a tracked pixel and the thread's markup are
-- on screen together. Threads you never reopen stay unbadged in the list. The
-- in-thread badge does not depend on this and works regardless.
-- ============================================================================

alter table public.messages add column if not exists legacy_thread_id text;

create index if not exists messages_legacy_thread_idx
  on public.messages (user_id, legacy_thread_id);

-- Replaced rather than overloaded: a second signature would leave two functions
-- differing only by argument count, and which one got called would depend on
-- what the caller happened to send.
drop function if exists public.note_self_view(text, text);

-- OR REPLACE so this file can be run twice without erroring. A plain CREATE here
-- failed on a second run with "function already exists with same argument types",
-- because the DROP above had already removed the only signature it could match —
-- which reads like the migration failed when in fact it had already succeeded.
create or replace function public.note_self_view(
  p_token            text,
  p_thread_id        text default null,
  p_legacy_thread_id text default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  m record;
begin
  select id, user_id, thread_id, legacy_thread_id into m
  from public.messages where token = p_token;

  if not found or m.user_id is distinct from auth.uid() then
    return;  -- not yours: say nothing, reveal nothing
  end if;

  if (p_thread_id is not null and m.thread_id is distinct from p_thread_id)
     or (p_legacy_thread_id is not null
         and m.legacy_thread_id is distinct from p_legacy_thread_id) then
    update public.messages
       set thread_id        = coalesce(p_thread_id, thread_id),
           legacy_thread_id = coalesce(p_legacy_thread_id, legacy_thread_id)
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

-- Expose the new column. Appended last: CREATE OR REPLACE VIEW may add columns
-- at the end but may not reorder or rename the existing ones.
create or replace view public.message_stats
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
  m.legacy_thread_id
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
