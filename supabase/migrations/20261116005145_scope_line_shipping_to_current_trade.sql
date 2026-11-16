-- A LINE shipment request belongs to a single trade and the current delivery assignee.
CREATE OR REPLACE FUNCTION app.line_shipping_context(p_item_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare i app.items;p app.delivery_line_preferences;q app.delivery_line_outbox;reason text;
begin
 select * into i from app.items where id=p_item_id;
 if auth.uid() is null or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active)
 or i.id is null or not app.is_admin() then raise exception '管理者のみLINE発送設定を確認できます' using errcode='42501';end if;
 select * into p from app.delivery_line_preferences where item_id=i.id;
 select o.* into q from app.delivery_line_outbox o
 join app.delivery_shipping_tasks t on t.id=o.task_id
 join app.delivery_line_links l on l.id=o.link_id and l.staff_id=i.deliverer_id and not l.blocked
 where t.item_id=i.id and i.status='取引中' and i.seller_cancelled_at is null
   and i.sold_on is null and o.trade_key is not distinct from i.seller_trade_key
   and (t.resolved_at is null or i.shipped_on is not null)
   and (app.sales_channel_family(i.sales_channel)='自己発送' or exists (
     select 1 from app.seller_listings s
     where s.item_id=i.id and s.active and s.channel=i.sales_channel and s.trade_key=i.seller_trade_key
   ))
 order by o.created_at desc limit 1;
 reason:=case when q.state='sent' then 'LINEで発送依頼を送信済み'
  when q.state='failed' then 'LINE送信に失敗しました。設定を確認してください'
  when q.state='sending' then 'LINEへ送信中です'
  when p.model_photo_id is null or p.overview_photo_id is null then '通知写真を指定してください'
  when q.id is null then 'この取引のLINE発送依頼は未送信です'
  when q.state='cancelled' then 'この発送依頼は終了しました'
  when q.last_error is not null then q.last_error
  when app.line_shipping_media(q.id) is null then '配送設定・発送コードの確認待ちです'
  else 'LINE通知の準備中です' end;
 return jsonb_build_object('photoOrder',app.line_listing_photo_order(i.id),'requiresPhotos',false,
  'photosReady',exists(select 1 from app.item_photos f join app.item_photos m on m.id=p.model_photo_id and coalesce(m.photo_kind,'product')='product' where f.id=p.overview_photo_id and coalesce(f.photo_kind,'product')='product'),
  'overviewPhotoId',p.overview_photo_id,'modelPhotoId',p.model_photo_id,'shipping',coalesce(p.shipping,'{}'),
  'state',q.state,'message',reason,'enabled',coalesce((select enabled from app.delivery_line_settings where singleton),false));
end $function$;

-- A cancelled merchant trade must not leave a dispatch date on its replacement.
do $migration$
declare
  definition text := pg_get_functiondef('app.perform_inventory_action(uuid,text,app.item_status,text,uuid)'::regprocedure);
  updated text := replace(definition,
    $old$update app.items set status=target,product_registered_at=case when p_action='resell'$old$,
    $new$update app.items set status=target,
    shipped_on=case when app.sales_channel_family(i.sales_channel) in ('メルカリ','ヤフオク','ヤフフリ','自己発送')
      then null else shipped_on end,
    product_registered_at=case when p_action='resell'$new$);
begin
  if updated = definition then
    raise exception 'Expected trade cancellation update not found';
  end if;
  execute updated;
end $migration$;

notify pgrst, 'reload schema';
