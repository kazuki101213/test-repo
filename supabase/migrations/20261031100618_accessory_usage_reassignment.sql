-- Usage changes move the same accessory record, preserving purchase/media/history IDs.
-- A dedicated RPC must not redirect those edits into either main product.
do $migration$
declare source text;patched text;
begin
 source:=pg_get_functiondef('app.redirect_accessory_shared_edits()'::regprocedure);
 patched:=regexp_replace(source,'begin',
  $guard$begin
  if old.id::text=current_setting('app.reassigning_accessory_id',true) and new.parent_item_id is distinct from old.parent_item_id then return new;end if;$guard$,'i');
 if source=patched then raise exception 'Accessory redirect anchor changed';end if;
 execute patched;
 -- Also retain the deployed sale guard's explicit-parent exception: mirrored
 -- accessory sale values are the same sale as their parent, not a second sale.
 source:=pg_get_functiondef('app.guard_single_product_sale()'::regprocedure);
 if position('i.id=new.parent_item_id' in source)=0 then
  patched:=replace(source,'and i.id<>new.id','and i.id<>new.id and not (new.is_accessory and i.id=new.parent_item_id)');
  if source=patched then raise exception 'Sale guard anchor changed';end if;
  execute patched;
 end if;
end $migration$;

-- Reconcile the deployed helper: retain each accessory's purchase tail and
-- suffix. The old migration-only implementation collapsed uppercase serials.
create or replace function app.accessory_sku_for_parent(p_parent_sku text,p_accessory_sku text)
returns text language plpgsql immutable set search_path='' as $$
declare
 parent_numeric text:=coalesce((regexp_match(p_parent_sku,'^([0-9]+)'))[1],'');
 accessory_serial text:=lower(coalesce((regexp_match(p_accessory_sku,'^([0-9]+[a-z]*)[-_]'))[1],''));
 accessory_letters text:=coalesce((regexp_match(accessory_serial,'^[0-9]+([a-z]*)$'))[1],'');
 tail text;
begin
 if parent_numeric='' then return p_parent_sku;end if;
 tail:=coalesce(substring(p_accessory_sku from '[-_].*$'),substring(p_parent_sku from '[-_].*$'));
 return parent_numeric||accessory_letters||tail;
end $$;

create function app.accessory_usage_context(p_item_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare i app.items;parent app.items;
begin
 select * into i from app.items where id=p_item_id;
 if auth.uid() is null or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active)
  or i.id is null or not coalesce(app.is_admin() or i.deliverer_id=app.current_staff_id(),false) then raise exception '担当する付属品のみ確認できます' using errcode='42501';end if;
 if not i.is_accessory or app.is_standalone_accessory_serial(i.sku,i.lot_seq) then raise exception '本体に付属する商品のみ利用記録を変更できます';end if;
 select * into parent from app.items where id=i.parent_item_id and not is_accessory;
 return jsonb_build_object('serial',lower(coalesce(app.product_serial(parent.sku,parent.lot_seq),app.product_serial(i.sku,i.lot_seq))),
  'revision',i.updated_at,'sku',i.sku);
end $$;

create function app.reassign_accessory_usage(p_item_id uuid,p_serial text,p_expected_revision timestamptz) returns jsonb
language plpgsql security definer set search_path='' as $$
declare i app.items;target app.items;original app.items;matches integer;serial text:=lower(btrim(p_serial));
 suffix text;original_serial text;tail text;candidate text;projected_sku text;attempt integer:=0;previous_marker text;middle_code text;
begin
 select * into i from app.items where id=p_item_id for update;
 if auth.uid() is null or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active)
  or i.id is null or not coalesce(app.is_admin() or i.deliverer_id=app.current_staff_id(),false) then raise exception '担当する付属品のみ変更できます' using errcode='42501';end if;
 if not i.is_accessory or app.is_standalone_accessory_serial(i.sku,i.lot_seq) then raise exception '本体に付属する商品のみ利用記録を変更できます';end if;
 if i.updated_at is distinct from p_expected_revision then raise exception '付属品が更新されています。画面を開き直してください' using errcode='40001';end if;
 if serial is null or serial !~ '^[1-9][0-9]*[a-z]*$' or length(serial)>32 then raise exception '使用先の通番号を入力してください';end if;
 select count(*) into matches from app.items where not is_accessory and lower(app.product_serial(sku,lot_seq))=serial;
 if matches<>1 then raise exception '使用先の本体を1件に特定できません。通番号を確認してください';end if;
 select * into target from app.items where not is_accessory and lower(app.product_serial(sku,lot_seq))=serial for update;
 if not app.is_admin() and target.deliverer_id is distinct from app.current_staff_id() then raise exception '担当外の本体には変更できません' using errcode='42501';end if;
 if target.deliverer_id is distinct from i.deliverer_id then raise exception '納品担当者が同じ本体を指定してください';end if;
 select * into original from app.items where id=i.parent_item_id and not is_accessory for update;
 if original.id is null then
  select count(*) into matches from app.items where not is_accessory and lot_seq=i.lot_seq and app.product_serial(sku,lot_seq)=app.product_serial(i.sku,i.lot_seq);
  if matches<>1 then raise exception '現在の本体を一意に確認できません';end if;
  select * into original from app.items where not is_accessory and lot_seq=i.lot_seq and app.product_serial(sku,lot_seq)=app.product_serial(i.sku,i.lot_seq) for update;
 end if;
 if target.id=original.id then return jsonb_build_object('item_id',i.id,'serial',serial,'sku',i.sku);end if;
 if i.shipped_on is not null or i.sold_on is not null or original.shipped_on is not null or original.sold_on is not null
  or target.shipped_on is not null or target.sold_on is not null or i.status='販売済' or original.status='販売済' or target.status='販売済' then
  raise exception '発送・販売完了した商品の利用記録は変更できません';end if;
 original_serial:=lower(app.product_serial(original.sku,original.lot_seq));
 suffix:=case when lower(app.product_serial(i.sku,i.lot_seq)) like original_serial||'%' then substring(lower(app.product_serial(i.sku,i.lot_seq)) from length(original_serial)+1) else '' end;
 -- Match the identity trigger's final SKU before checking collisions, even when
 -- a previous parent synchronization left a different date/cost in the old SKU.
 select coalesce((select code from app.staff where id=i.purchaser_id),'')||coalesce((select code from app.staff where id=i.deliverer_id),'') into middle_code;
 if middle_code='' then middle_code:=split_part(i.sku,'-',2);end if;
 tail:='-'||middle_code||'-'||coalesce(to_char(i.purchased_at,'YYYYMMDD'),split_part(i.sku,'-',3))||'-'||(i.cost_amount/10)::text;
 loop
  candidate:=app.return_sku_original_cost(serial||suffix||tail,target.lot_seq);
  -- Main-product updates later synchronize all accessory SKU tails. Reserve a
  -- distinct serial under that transformation too, not just today's full SKU.
  projected_sku:=app.return_sku_original_cost(app.accessory_sku_for_parent(target.sku,candidate),target.lot_seq);
  exit when not exists(select 1 from app.items where sku=candidate and id<>i.id)
   and not exists(select 1 from app.item_sku_aliases where sku in(candidate,projected_sku) and item_id<>i.id)
   and not exists(select 1 from app.items where sku=projected_sku and id<>i.id)
   and not exists(select 1 from app.items a where a.parent_item_id=target.id and a.is_accessory and a.id<>i.id
    and app.product_serial(a.sku,a.lot_seq)=app.product_serial(candidate,target.lot_seq))
   and not exists(select 1 from app.items a where a.parent_item_id=target.id and a.is_accessory and a.id<>i.id
    and app.return_sku_original_cost(app.accessory_sku_for_parent(target.sku,a.sku),target.lot_seq)=projected_sku);
  suffix:=suffix||'a';attempt:=attempt+1;
  if attempt>30 then raise exception '使用先の付属品SKUを確保できません';end if;
 end loop;
 previous_marker:=current_setting('app.reassigning_accessory_id',true);
 perform set_config('app.reassigning_accessory_id',i.id::text,true);
 update app.items set parent_item_id=target.id,lot_seq=target.lot_seq,sku=candidate,
  status=target.status,packed_on=target.packed_on,shipped_on=target.shipped_on,returned_on=target.returned_on,
  sales_channel=target.sales_channel,condition=target.condition,sold_on=target.sold_on,sold_price=target.sold_price,payout_amount=target.payout_amount
 where id=i.id;
 perform set_config('app.reassigning_accessory_id',coalesce(previous_marker,''),true);
 update app.spare_shipping_tasks set item_id=target.id,lot_seq=target.lot_seq
 where accessory_item_id=i.id and sent_at is null and completed_at is null;
 return jsonb_build_object('item_id',i.id,'serial',serial,'sku',(select sku from app.items where id=i.id));
end $$;
revoke all on function app.accessory_usage_context(uuid),app.reassign_accessory_usage(uuid,text,timestamptz) from public,anon;
grant execute on function app.accessory_usage_context(uuid),app.reassign_accessory_usage(uuid,text,timestamptz) to authenticated;
