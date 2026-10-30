-- Shipping requests are notifications, not a prerequisite for listing.
-- Keep the ordinary listing approval and operation-id protections.
do $migration$
declare source text;patched text;
begin
 source:=pg_get_functiondef('app.queue_seller_operation(uuid,text,jsonb,uuid)'::regprocedure);
 patched:=replace(source,$gate$IF coalesce((app.line_shipping_context(i.id)->>'requiresPhotos')::boolean,false)
      AND NOT coalesce((app.line_shipping_context(i.id)->>'photosReady')::boolean,false) THEN
      RAISE EXCEPTION '出品前にLINE発送依頼の全体写真と型番確認写真を保存してください';
    END IF;$gate$,'');
 if source=patched then raise exception 'Listing LINE gate anchor changed';end if;
 execute patched;
 source:=pg_get_functiondef('app.read_resource_snapshot(text,jsonb,jsonb)'::regprocedure);
 patched:=replace(source,$old$,case when lc.value->>'state' in ('pending','sending','failed') then lc.value->>'message' end as line_message$old$,'');
 patched:=replace(patched,' left join lateral(select app.line_shipping_context(i.id) value) lc on true','');
 patched:=replace(patched,$old$(t.created_at<=now()-interval '24 hours' or lc.value->>'state' in ('pending','sending','failed'))$old$,$new$t.created_at<=now()-interval '24 hours'$new$);
 if source=patched or position('lc.value' in patched)>0 then raise exception 'Shipping reminder rollback anchor changed';end if;
 execute patched;
 -- Cached clients must also release the withdrawn listing restriction.
 source:=pg_get_functiondef('app.line_shipping_context(uuid)'::regprocedure);
 patched:=replace(source,$old$'requiresPhotos',coalesce((select enabled from app.delivery_line_settings where singleton),false)
   and i.sales_channel in ('メルカリ','ヤフオク') and exists(select 1 from app.delivery_line_links l join app.staff s on s.id=l.staff_id and s.is_active where l.staff_id=i.deliverer_id and not l.blocked),$old$,$new$'requiresPhotos',false,$new$);
 patched:=replace(patched,$old$when exists(select 1 from app.delivery_notice_completions c where c.item_id=i.id and c.staff_id=i.deliverer_id and c.notice_id='shipping:'||q.task_id::text) then '担当者が発送依頼を完了しています。自動通知は停止しています'$old$,'');
 if source=patched then raise exception 'LINE context rollback anchor changed';end if;
 execute patched;
end $migration$;

-- Acknowledge/hide in-app cards independently from sending a shipping request.
-- Explicitly cancelled requests (including a user's no-reissue instruction) stay cancelled.
create or replace function app.line_shipping_eligible(p_id uuid) returns boolean
language sql stable set search_path='' as $$
 select coalesce((select not l.blocked and s.is_active and s.id=i.deliverer_id
  and o.state<>'cancelled' and t.resolved_at is null and i.status='取引中' and i.shipped_on is null
  and i.sold_on is null and i.seller_cancelled_at is null
  and (i.sales_channel='自己発送' or (i.sales_channel in ('メルカリ','ヤフオク') and o.trade_key=i.seller_trade_key
   and exists(select 1 from app.seller_listings sl where sl.item_id=i.id and sl.active and sl.trade_key=o.trade_key and sl.channel=i.sales_channel)))
 from app.delivery_line_outbox o join app.delivery_line_links l on l.id=o.link_id join app.staff s on s.id=l.staff_id
 join app.delivery_shipping_tasks t on t.id=o.task_id join app.items i on i.id=t.item_id where o.id=p_id),false);
$$;

create or replace function app.line_shipping_media(p_id uuid) returns jsonb
language sql stable set search_path='' as $$
 select jsonb_build_object('itemId',i.id,'serial',app.product_serial(i.sku,i.lot_seq),'sku',i.sku,
  'supplierUrl',i.marketplace_url,'automatic',true,
  'photoPaths',case when front.id is not null and model.id is not null then jsonb_build_array(front.storage_path,model.storage_path)
   else coalesce((select jsonb_agg(f.storage_path order by f.created_at,f.id) from
    (select p.storage_path,p.created_at,p.id from app.item_photos p where p.item_id=i.id and coalesce(p.photo_kind,'product')='product'
     and p.storage_path ~* '\.(jpe?g|png)$' order by p.created_at,p.id limit 2) f),'[]'::jsonb) end,
  'codeOperationId',code.id)
 from app.delivery_line_outbox o join app.delivery_shipping_tasks t on t.id=o.task_id join app.items i on i.id=t.item_id
 left join app.delivery_line_preferences pref on pref.item_id=i.id
 left join app.item_photos front on front.id=pref.overview_photo_id and coalesce(front.photo_kind,'product')='product'
 left join app.item_photos model on model.id=pref.model_photo_id and coalesce(model.photo_kind,'product')='product'
 left join lateral(select op.id from app.seller_operations op join app.seller_listings sl on sl.item_id=i.id and sl.active and sl.trade_key=o.trade_key
  where op.item_id=i.id and op.account_id=sl.account_id and op.channel=sl.channel and op.kind in ('shipping_code','register_package')
   and op.status='succeeded' and op.payload->>'trade_key'=o.trade_key and op.created_at>=t.created_at-interval '5 minutes'
   and nullif(op.result->>'qr_code','') is not null order by op.created_at desc limit 1) code on true
 where o.id=p_id and app.line_shipping_eligible(o.id);
$$;

-- Fill only current, unshipped work. Never reset sent/cancelled rows or their retry keys.
create function app.ensure_line_shipping_requests(p_staff uuid default null) returns integer
language plpgsql security definer set search_path='' as $$
declare queued integer;
begin
 if not coalesce((select enabled from app.delivery_line_settings where singleton),false) then return 0;end if;
 insert into app.delivery_line_outbox(task_id,link_id,trade_key)
 select t.id,l.id,i.seller_trade_key from app.delivery_shipping_tasks t join app.items i on i.id=t.item_id
 join app.staff s on s.id=i.deliverer_id and s.is_active join app.delivery_line_links l on l.staff_id=s.id and not l.blocked
 where t.resolved_at is null and i.status='取引中' and i.shipped_on is null and i.sold_on is null and i.seller_cancelled_at is null
  and (p_staff is null or s.id=p_staff)
  and (i.sales_channel='自己発送' or (i.sales_channel in ('メルカリ','ヤフオク') and i.seller_trade_key is not null
   and exists(select 1 from app.seller_listings sl where sl.item_id=i.id and sl.active and sl.channel=i.sales_channel and sl.trade_key=i.seller_trade_key)))
 on conflict do nothing;
 get diagnostics queued=row_count;
 update app.delivery_line_outbox o set trade_key=i.seller_trade_key from app.delivery_shipping_tasks t,app.items i
 where o.task_id=t.id and t.item_id=i.id and o.trade_key is null and o.state='pending' and o.attempts=0
  and i.seller_trade_key is not null and t.resolved_at is null and (p_staff is null or i.deliverer_id=p_staff);
 return queued;
end $$;
revoke all on function app.ensure_line_shipping_requests(uuid) from public,anon,authenticated;
grant execute on function app.ensure_line_shipping_requests(uuid) to service_role;

create or replace function app.capture_delivery_line_shipping() returns trigger
language plpgsql security definer set search_path='' as $$
declare target uuid;
begin
 if tg_table_name='delivery_shipping_tasks' or tg_table_name='seller_listings' then
  select deliverer_id into target from app.items where id=new.item_id;
 else target:=new.deliverer_id;end if;
 perform app.ensure_line_shipping_requests(target);
 perform app.kick_delivery_line();
 return new;
end $$;
create trigger seller_listings_line_shipping after insert or update of active,trade_key on app.seller_listings
 for each row execute function app.capture_delivery_line_shipping();
create trigger items_line_trade_ready after update of seller_trade_key on app.items
 for each row when(old.seller_trade_key is distinct from new.seller_trade_key) execute function app.capture_delivery_line_shipping();

-- A newly connected staff member receives their current waiting work too.
do $migration$
declare source text;patched text;
begin
 source:=pg_get_functiondef('app.handle_delivery_line_event(text,text,text,text)'::regprocedure);
 patched:=replace(source,' return true;', ' perform app.ensure_line_shipping_requests(target); perform app.kick_delivery_line(); return true;');
 if source=patched then raise exception 'LINE linking anchor changed';end if;
 execute patched;
 source:=pg_get_functiondef('app.extension_prepare_line_shipping(text[])'::regprocedure);
 patched:=replace(source,$old$for o in select q.id$old$,$new$perform app.ensure_line_shipping_requests();
 for o in select q.id$new$);
 -- Code preparation may continue when settings are present, but is never a notification gate.
 patched:=replace(patched,'if app.line_shipping_media(o.id) is not null then continue;end if;',
  $new$if app.line_shipping_media(o.id)->>'codeOperationId' is not null then continue;end if;$new$);
 if source=patched then raise exception 'LINE patrol anchor changed';end if;
 execute patched;
end $migration$;

-- Admin repair uses the same queue and retry keys; it never reissues sent requests.
create function app.refresh_delivery_line_shipping() returns integer
language plpgsql security definer set search_path='' as $$
declare queued integer;
begin
 if auth.uid() is null or not app.is_admin() or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active) then raise exception '管理者のみ操作できます' using errcode='42501';end if;
 queued:=app.ensure_line_shipping_requests();perform app.kick_delivery_line();return queued;
end $$;
revoke all on function app.refresh_delivery_line_shipping() from public,anon;
grant execute on function app.refresh_delivery_line_shipping() to authenticated;
