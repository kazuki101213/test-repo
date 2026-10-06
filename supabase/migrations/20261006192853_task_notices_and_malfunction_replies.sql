-- Reading an item acknowledges only the exact reply/approval that was displayed.
create table app.item_notice_reads (
  staff_id uuid not null references app.staff(id) on delete cascade,
  item_id uuid not null references app.items(id) on delete cascade,
  reply_read_at timestamptz,
  photo_read_at timestamptz,
  primary key (staff_id, item_id)
);
alter table app.item_notice_reads enable row level security;
revoke all on app.item_notice_reads from public, anon, authenticated;
grant select on app.item_notice_reads to authenticated;
grant all on app.item_notice_reads to service_role;
create policy item_notice_reads_self on app.item_notice_reads for select to authenticated
  using (staff_id = app.current_staff_id());

create function app.list_delivery_item_notices()
returns table(item_id uuid, lot_seq bigint, reply_at timestamptz, photo_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select i.id, i.lot_seq::bigint,
    case when c.last_reply > coalesce(r.reply_read_at, '-infinity'::timestamptz) then c.last_reply end,
    case when p.approved_at > coalesce(r.photo_read_at, '-infinity'::timestamptz) then p.approved_at end
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
    and (c.last_reply > coalesce(r.reply_read_at, '-infinity'::timestamptz)
      or p.approved_at > coalesce(r.photo_read_at, '-infinity'::timestamptz));
$$;
revoke all on function app.list_delivery_item_notices() from public, anon;
grant execute on function app.list_delivery_item_notices() to authenticated;

create function app.mark_item_notices_read(p_item_id uuid, p_reply_through timestamptz default null, p_photo_through timestamptz default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or app.current_staff_id() is null or app.current_role() is null then
    raise exception 'ログインが必要です' using errcode='42501';
  end if;
  perform app.assert_can_work_on(p_item_id);
  if p_reply_through is not null and not exists (
    select 1 from app.item_comments c join app.staff s on s.id=c.author_id
    join app.items i on i.id=c.item_id
    where c.item_id=p_item_id and c.created_at=p_reply_through
      and c.created_at>i.malfunction_reported_at and s.role in ('admin','purchaser')
      and c.author_id<>app.current_staff_id()
  ) then raise exception '返信通知が見つかりません' using errcode='22023'; end if;
  if p_photo_through is not null and not exists (
    select 1 from app.photo_reviews where item_id=p_item_id and approved_at=p_photo_through
  ) then raise exception '写真承認が更新されています。再読み込みしてください' using errcode='22023'; end if;
  insert into app.item_notice_reads(staff_id,item_id,reply_read_at,photo_read_at)
  values(app.current_staff_id(),p_item_id,p_reply_through,p_photo_through)
  on conflict(staff_id,item_id) do update set
    reply_read_at=greatest(app.item_notice_reads.reply_read_at,excluded.reply_read_at),
    photo_read_at=greatest(app.item_notice_reads.photo_read_at,excluded.photo_read_at);
end $$;
revoke all on function app.mark_item_notices_read(uuid,timestamptz,timestamptz) from public, anon;
grant execute on function app.mark_item_notices_read(uuid,timestamptz,timestamptz) to authenticated;

-- Own registered ID wins. Only an unambiguous original of the same returned product is a fallback.
create function app.resolve_task_product_id(p_item_id uuid)
returns text language sql stable security invoker set search_path='' as $$
  select coalesce(nullif(btrim(i.marketplace_item_id),''),
    case when i.marketplace::text='Amazon返品' and i.sku ~ '^[0-9]+[a-zA-Z]+-' and i.asin is not null then
      (select case when count(*)=1 then min(nullif(btrim(o.marketplace_item_id),'')) end
       from app.items o where o.lot_seq=i.lot_seq and o.asin=i.asin
         and not o.is_accessory and o.sku ~ '^[0-9]+-' and o.id<>i.id
         and nullif(btrim(o.marketplace_item_id),'') is not null)
    end)
  from app.items i where i.id=p_item_id;
$$;
revoke all on function app.resolve_task_product_id(uuid) from public, anon;
grant execute on function app.resolve_task_product_id(uuid) to authenticated;

create view app.v_item_action_tasks with (security_invoker=true) as
  select c.id,c.item_id,c.task_kind,c.task_completed_at,c.created_at,
    i.lot_seq,i.sku,app.resolve_task_product_id(i.id) as marketplace_item_id
  from app.item_comments c join app.items i on i.id=c.item_id
  where c.task_kind is not null;
revoke all on app.v_item_action_tasks from public, anon;
grant select on app.v_item_action_tasks to authenticated;

-- Channel transition and resolution are in the same transaction as the reply.
create function app.apply_malfunction_reply()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if auth.uid() is null or new.author_id is distinct from app.current_staff_id()
    or not coalesce(app.current_role() in ('admin','purchaser'),false) then return new; end if;
  if app.current_role()='purchaser' and not exists (
    select 1 from app.items where id=new.item_id and purchaser_id=app.current_staff_id()
  ) then raise exception '担当外の商品には返信できません' using errcode='42501'; end if;
  if new.task_kind like '%ヤフオク%' then perform app.prepare_yahoo_auction_item(new.item_id); end if;
  update app.items set malfunction_resolved_at=clock_timestamp(),malfunction_resolved_by=new.author_id
    where id=new.item_id and malfunction_reported and malfunction_resolved_at is null
      and new.created_at>malfunction_reported_at;
  return new;
end $$;
revoke all on function app.apply_malfunction_reply() from public, anon, authenticated;
create trigger item_comments_apply_malfunction_reply after insert on app.item_comments
  for each row execute function app.apply_malfunction_reply();

create function app.send_malfunction_reply(p_comment_id uuid,p_item_id uuid,p_body text,p_task_kind text,p_photo_paths text[] default '{}')
returns void language plpgsql security definer set search_path='' as $$
declare v_sku text; v_existing app.item_comments%rowtype;
begin
  if auth.uid() is null or not coalesce(app.current_role() in ('admin','purchaser'),false) then
    raise exception '返信する権限がありません' using errcode='42501'; end if;
  select sku into v_sku from app.items where id=p_item_id and (app.is_admin() or purchaser_id=app.current_staff_id()) for update;
  if not found then raise exception '対象商品が見つかりません' using errcode='42501'; end if;
  if length(btrim(coalesce(p_body,'')))=0 or length(p_body)>2000 or coalesce(cardinality(p_photo_paths),0)>10 then
    raise exception '返信内容・写真枚数を確認してください' using errcode='22023'; end if;
  if exists(select 1 from unnest(p_photo_paths) p where p is null or p not like v_sku||'/reply/'||p_comment_id::text||'/%') then
    raise exception '写真の対象商品が一致しません' using errcode='22023'; end if;
  select * into v_existing from app.item_comments where id=p_comment_id;
  if found then
    if v_existing.item_id=p_item_id and v_existing.author_id=app.current_staff_id() and v_existing.body=btrim(p_body)
      and v_existing.task_kind is not distinct from p_task_kind
      and coalesce((select array_agg(storage_path order by sort_order) from app.item_comment_photos where item_comment_id=p_comment_id),'{}'::text[])
        =coalesce(p_photo_paths,'{}'::text[]) then return; end if;
    raise exception '返信IDが重複しています' using errcode='22023';
  end if;
  insert into app.item_comments(id,item_id,author_id,body,task_kind)
    values(p_comment_id,p_item_id,app.current_staff_id(),btrim(p_body),p_task_kind);
  insert into app.item_comment_photos(item_comment_id,item_id,storage_path,sort_order)
    select p_comment_id,p_item_id,p,(n-1)::smallint from unnest(p_photo_paths) with ordinality as x(p,n);
end $$;
revoke all on function app.send_malfunction_reply(uuid,uuid,text,text,text[]) from public, anon;
grant execute on function app.send_malfunction_reply(uuid,uuid,text,text,text[]) to authenticated;
notify pgrst,'reload schema';
