-- Gate the code image on the product catalog size and provide an authenticated
-- resend path for an explicitly requested, previously sent LINE notification.

create or replace function app.line_shipping_media(p_id uuid) returns jsonb
language sql stable set search_path='' as $$
 select case
  when required.shipping_size is not null and code.id is null then null
  else jsonb_build_object(
   'itemId',i.id,
   'serial',app.product_serial(i.sku,i.lot_seq),
   'sku',i.sku,
   'supplierUrl',i.marketplace_url,
   'automatic',true,
   'photoPaths',jsonb_build_array(front.storage_path,model.storage_path),
   'codeOperationId',case when required.shipping_size is not null then code.id end,
   'withoutBarcode',case when required.shipping_size is null then 'size_unset' end
  )
 end
 from app.delivery_line_outbox o
 join app.delivery_shipping_tasks t on t.id=o.task_id
 join app.items i on i.id=t.item_id
 join app.delivery_line_preferences pref on pref.item_id=i.id
 join app.item_photos front on front.id=pref.overview_photo_id
  and front.item_id=i.id and coalesce(front.photo_kind,'product')='product'
 join app.item_photos model on model.id=pref.model_photo_id
  and model.item_id=i.id and coalesce(model.photo_kind,'product')='product'
 left join app.seller_listings listing on listing.item_id=i.id and listing.active
  and listing.trade_key=o.trade_key
 left join lateral (
  select app.line_fixed_shipping_size(i.id) as shipping_size
 ) required on true
 left join lateral (
  select op.id
  from app.seller_operations op
  where required.shipping_size is not null
   and listing.item_id is not null
   and op.item_id=i.id
   and op.account_id=listing.account_id
   and op.channel=listing.channel
   and op.kind in ('shipping_code','register_package')
   and op.status='succeeded'
   and op.payload->>'trade_key'=o.trade_key
   and op.created_at>=t.created_at-interval '5 minutes'
   and nullif(op.result->>'qr_code','') is not null
  order by op.created_at desc limit 1
 ) code on true
 where o.id=p_id and app.line_shipping_eligible(o.id)
  and pref.overview_photo_id is not null and pref.model_photo_id is not null;
$$;

create or replace function app.request_delivery_line_resend(p_item_id uuid)
returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 i app.items;
 task uuid;
 link uuid;
 outbox uuid;
 required_size text;
begin
 if auth.uid() is null or not exists(
  select 1 from app.staff s where s.id=app.current_staff_id() and s.is_active
 ) then raise exception 'ログインが必要です' using errcode='42501'; end if;

 select * into i from app.items where id=p_item_id for update;
 if i.id is null or not (app.is_admin() or i.deliverer_id=app.current_staff_id()) then
  raise exception '担当商品だけ再送できます' using errcode='42501';
 end if;
 if i.status<>'取引中' or i.shipped_on is not null or i.sold_on is not null
  or i.seller_cancelled_at is not null or i.seller_trade_key is null then
  raise exception '現在の未発送取引を確認できません';
 end if;
 if not coalesce((select enabled from app.delivery_line_settings where singleton),false) then
  raise exception 'LINE通知が有効ではありません';
 end if;
 if not exists(
  select 1 from app.delivery_line_preferences pref
  join app.item_photos front on front.id=pref.overview_photo_id and front.item_id=i.id
   and coalesce(front.photo_kind,'product')='product'
  join app.item_photos model on model.id=pref.model_photo_id and model.item_id=i.id
   and coalesce(model.photo_kind,'product')='product'
  where pref.item_id=i.id
 ) then raise exception '全体写真と型番写真を先に保存してください'; end if;

 select t.id into task from app.delivery_shipping_tasks t
 where t.item_id=i.id and t.resolved_at is null order by t.created_at desc limit 1;
 if task is null then raise exception '未完了の発送依頼がありません'; end if;
 select l.id into link from app.delivery_line_links l
 join app.staff s on s.id=l.staff_id and s.is_active and not l.blocked
 where l.staff_id=i.deliverer_id order by l.linked_at desc limit 1;
 if link is null then raise exception 'LINE連携を確認してください'; end if;
 select o.id into outbox from app.delivery_line_outbox o
 where o.task_id=task and o.link_id=link and o.trade_key=i.seller_trade_key
 for update;
 if outbox is null then raise exception '現在の取引に対応するLINE通知がありません'; end if;
 if not exists(select 1 from app.delivery_line_outbox where id=outbox and state='sent') then
  raise exception '再送できる送信済み通知がありません';
 end if;

 required_size:=app.line_fixed_shipping_size(i.id);
 update app.delivery_line_outbox set state='pending',attempts=0,next_attempt_at=now(),
  first_attempt_at=null,sent_at=null,last_status=null,lease=null,message_payload=null,
  last_error=null,code_cleaned_at=null
 where id=outbox;
 perform app.kick_delivery_line();
 return jsonb_build_object('queued',true,'codeRequired',required_size is not null,'outboxId',outbox);
end $$;

revoke all on function app.request_delivery_line_resend(uuid) from public,anon;
grant execute on function app.request_delivery_line_resend(uuid) to authenticated;
notify pgrst,'reload schema';
