-- 管理アプリの動作不良で「返送依頼(ヤフオク)／返送依頼(メルカリ)」の定型文を納品担当者へ送ったら、
-- 納品アプリのやることに「返送お願いします。」を出す（2026-11-21 ユーザー指定）。
-- ・返送依頼の返信は「動作不良への返信があります。」ではなく「返送お願いします。」として出す。
-- ・動作確認のカードと同じく、作業（返品完了・返品不可・動作不良取消など）で動作不良でなくなるまで出し続ける。
alter table app.item_comments add column if not exists return_request boolean not null default false;

-- 返送依頼かどうかを受け取れるようにする（既存の5引数の呼び出しはそのまま使える）。
drop function app.send_malfunction_reply(uuid,uuid,text,text,text[]);
create function app.send_malfunction_reply(p_comment_id uuid, p_item_id uuid, p_body text, p_task_kind text,
  p_photo_paths text[] default '{}'::text[], p_return_request boolean default false)
 returns void
 language plpgsql
 security definer
 set search_path to ''
as $function$
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
      and v_existing.return_request=coalesce(p_return_request,false)
      and coalesce((select array_agg(storage_path order by sort_order) from app.item_comment_photos where item_comment_id=p_comment_id),'{}'::text[])
        =coalesce(p_photo_paths,'{}'::text[]) then return; end if;
    raise exception '返信IDが重複しています' using errcode='22023';
  end if;
  insert into app.item_comments(id,item_id,author_id,body,task_kind,return_request)
    values(p_comment_id,p_item_id,app.current_staff_id(),btrim(p_body),p_task_kind,coalesce(p_return_request,false));
  insert into app.item_comment_photos(item_comment_id,item_id,storage_path,sort_order)
    select p_comment_id,p_item_id,p,(n-1)::smallint from unnest(p_photo_paths) with ordinality as x(p,n);
end $function$;
revoke all on function app.send_malfunction_reply(uuid,uuid,text,text,text[],boolean) from public,anon;
grant execute on function app.send_malfunction_reply(uuid,uuid,text,text,text[],boolean) to authenticated;

do $patch$
declare
  definition text := pg_get_viewdef('app.v_delivery_notice_tasks'::regclass);
  old_reply constant text := 'WHERE ((s.role = ANY';
  new_reply constant text := 'WHERE ((NOT c.return_request) AND (s.role = ANY';
  old_shipping constant text := 'SELECT (''shipping:''::text';
  new_shipping constant text := $new$SELECT ('return_request:'::text || (c.id)::text),
            i.id,
            'return_request'::text AS text,
            c.created_at,
            i.sku,
            i.lot_seq,
            i.marketplace_item_id,
            i.marketplace,
            i.marketplace_url,
            c.body
           FROM (app.item_comments c
             JOIN app.items i ON ((i.id = c.item_id)))
          WHERE (c.return_request AND (i.status = '動作不良'::app.item_status) AND (c.created_at > i.malfunction_reported_at))
        UNION ALL
         SELECT ('shipping:'::text$new$;
begin
  if strpos(definition, old_reply)=0 or strpos(definition, old_shipping)=0
     or strpos(definition, 'return_request')>0 then
    raise exception 'v_delivery_notice_tasks changed unexpectedly';
  end if;
  execute 'create or replace view app.v_delivery_notice_tasks with (security_invoker=true) as '
    || replace(replace(definition, old_reply, new_reply), old_shipping, new_shipping);
end
$patch$;
notify pgrst, 'reload schema';
