-- Hide each unread notice 72 hours after its source event, without deleting history.
-- Keep the existing caller/assignee checks and the exact-event acknowledgement API.
create or replace function app.list_delivery_item_notices()
returns table(item_id uuid, lot_seq bigint, reply_at timestamptz, photo_at timestamptz)
language sql stable security definer set search_path = '' as $$
  with notices as (
    select i.id, i.lot_seq::bigint,
      case when c.last_reply > coalesce(r.reply_read_at, '-infinity'::timestamptz)
        and c.last_reply > now() - interval '72 hours' then c.last_reply end as reply_at,
      case when p.approved_at > coalesce(r.photo_read_at, '-infinity'::timestamptz)
        and p.approved_at > now() - interval '72 hours' then p.approved_at end as photo_at
    from app.items i
    left join app.item_notice_reads r on r.item_id=i.id and r.staff_id=app.current_staff_id()
    left join app.photo_reviews p on p.item_id=i.id
    left join lateral (
      select max(cm.created_at) last_reply from app.item_comments cm
      join app.staff s on s.id=cm.author_id
      where cm.item_id=i.id and cm.created_at>i.malfunction_reported_at
        and cm.author_id<>app.current_staff_id() and s.role in ('admin','purchaser')
    ) c on true
    where auth.uid() is not null and app.current_staff_id() is not null and app.current_role() is not null
      and (app.is_admin() or i.deliverer_id=app.current_staff_id())
  )
  select id, lot_seq, reply_at, photo_at from notices
  where reply_at is not null or photo_at is not null;
$$;
revoke all on function app.list_delivery_item_notices() from public, anon;
grant execute on function app.list_delivery_item_notices() to authenticated;
