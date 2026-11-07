-- Keep the submitted photo order and permit one explicit recovery of a vanished SKU.
alter table app.amazon_listing_submissions
 add column photo_ids uuid[] not null default '{}',
 add column photo_fingerprint text,
 add column photos_verified_at timestamptz,
 add column photo_submitted_at timestamptz,
 add column photo_submitted_fingerprint text,
 add column photo_submission_id text,
 add column recovery_count smallint not null default 0 check(recovery_count between 0 and 1),
 add column recovery_at timestamptz,
 add column recovery_submission_id text;

-- Cost/date edits still generate inventory SKUs as before. A verified Amazon SKU
-- can be an alias of the same inventory item; it must never belong to another item.
do $$declare original text;patched text;begin
 original:=pg_get_functiondef('app.perform_inventory_action(uuid,text,app.item_status,text,uuid)'::regprocedure);
 patched:=replace(original,'s.sku=i.sku and s.asin=',
  '(s.sku=i.sku or exists(select 1 from app.item_sku_aliases a where a.item_id=i.id and a.sku=s.sku)) and s.asin=');
 if patched=original then raise exception 'Amazon SKU verification anchor missing';end if;
 execute patched;
end $$;

-- The server verifies Amazon and photograph contents before calling this RPC.
-- No user JWT is manufactured: the original request records the real actor.
-- The service role has no general items UPDATE/workflow INSERT grants. This
-- narrowly scoped definer RPC authorizes only a fresh verified receipt, retaining
-- the actor, item snapshot, approval, alias and idempotency checks below.
create function app.complete_verified_amazon_listing(p_request_id uuid,p_expected_sku text) returns void
language plpgsql security definer set search_path=pg_catalog,app as $$
declare r app.amazon_listing_submissions;i app.items;actor app.staff;event app.inventory_workflow_events;
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception '内部処理専用です' using errcode='42501';end if;
 select * into r from app.amazon_listing_submissions where request_id=p_request_id for update;
 if r.request_id is null or r.state<>'verified' or r.verified_at is null or r.verified_at<clock_timestamp()-interval '10 minutes'
  or r.photos_verified_at is null or r.photos_verified_at<clock_timestamp()-interval '10 minutes'
  or r.photo_fingerprint is null then raise exception 'Amazonと写真の確認が必要です' using errcode='42501';end if;
 select * into i from app.items where id=r.item_id for update;
 if i.id is null or i.sku is distinct from p_expected_sku or i.status not in ('商品登録前','出品中')
  or i.is_accessory and not app.is_standalone_accessory_serial(i.sku,i.lot_seq)
  or i.asin::text is distinct from r.asin or i.sales_channel is distinct from r.sales_channel
  or i.planned_price is distinct from r.price or i.condition::text is distinct from r.item_condition
  or coalesce(i.description,'') is distinct from r.description
  or r.seller_id is distinct from (case when i.sales_channel::text in ('FBA2','自己発送2') then 'A3E7BXJWH9TP11' else 'A1WI3OGPE43N2T' end)
  or not(i.sku=r.sku or exists(select 1 from app.item_sku_aliases a where a.item_id=i.id and a.sku=r.sku))
 then raise exception '確認後に商品情報が変更されています' using errcode='40001';end if;
 select s.* into actor from app.staff s join app.profiles p on p.staff_id=s.id where p.user_id=r.requested_by;
 if actor.id is null or not actor.is_active or not(actor.role='admin' or actor.id=i.deliverer_id)
 then raise exception '元の出品依頼者の権限を確認できません' using errcode='42501';end if;
 if not app.listing_photos_approved(i.id) or cardinality(r.photo_ids) not between 1 and 6
  or (select count(distinct x) from unnest(r.photo_ids)x)<>cardinality(r.photo_ids)
  or exists(select 1 from unnest(r.photo_ids)x where not exists(select 1 from app.item_photos p where p.id=x and p.item_id=i.id and p.photo_kind='product'))
 then raise exception '承認済みの商品写真を確認してください' using errcode='42501';end if;
 perform app.validate_work_completion_date(r.work_completed_on,i.purchased_at);
 select * into event from app.inventory_workflow_events where id=r.request_id;
 if event.id is not null then
  if event.item_id=i.id and event.action='listing_complete' and i.status='出品中' then return;end if;
  raise exception '操作IDが重複しています' using errcode='22023';
 end if;
 if i.status<>'商品登録前' then raise exception '出品状態が変更されています' using errcode='40001';end if;
 update app.items set status='出品中',product_registered_at=clock_timestamp(),
  packed_on=coalesce(packed_on,r.work_completed_on),packed_completed_at=coalesce(packed_completed_at,clock_timestamp()) where id=i.id;
 insert into app.inventory_workflow_events(id,item_id,actor_id,action,from_status,to_status,note)
 values(r.request_id,i.id,actor.id,'listing_complete',i.status,'出品中','Amazon登録SKU: '||r.sku);
end $$;
revoke all on function app.complete_verified_amazon_listing(uuid,text) from public,anon,authenticated;
grant execute on function app.complete_verified_amazon_listing(uuid,text) to service_role;
notify pgrst,'reload schema';
