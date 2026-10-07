-- Remove the retired arrival concept and unify work metrics.
CREATE OR REPLACE FUNCTION app.set_delivery_progress(p_item_id uuid, p_step text, p_done boolean, p_on date DEFAULT NULL::date)
 RETURNS app.items
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare result app.items; today_jst date := (now() at time zone 'Asia/Tokyo')::date; photo_exempt boolean;
begin
 if auth.uid() is null then raise exception 'ログインが必要です' using errcode='42501'; end if;
 if p_done is null or p_step not in ('inspection_cleaning','listing','packed','shipped') then
  raise exception '作業項目を確認してください' using errcode='22023';
 end if;
 if p_done and p_step in ('packed','shipped') and p_on is null then
  raise exception '日付を入力してください' using errcode='22023';
 end if;
 perform app.assert_can_work_on(p_item_id);
 select marketplace::text='動作品Amazon返品' into photo_exempt from app.items where id=p_item_id;
 if p_done and p_step in ('packed','shipped') and not coalesce(photo_exempt,false)
   and app.photo_review_enforced() and not app.is_delivery_master()
   and not exists (select 1 from app.photo_reviews r where r.item_id=p_item_id and r.approved_at is not null) then
   raise exception '管理アプリの写真確認が完了するまで、梱包・出荷はできません' using errcode='42501';
 end if;
 update app.items set
  inspected_at=case when p_step='inspection_cleaning' then case when p_done then coalesce(inspected_at,now()) else null end else inspected_at end,
  cleaned_at=case when p_step='inspection_cleaning' then case when p_done then coalesce(cleaned_at,now()) else null end else cleaned_at end,
  product_registered_at=case when p_step='listing' then case when p_done then coalesce(product_registered_at,now()) else null end else product_registered_at end,
  photo_uploaded_at=case when p_step='listing' and not coalesce(photo_exempt,false) then case when p_done then coalesce(photo_uploaded_at,now()) else null end else photo_uploaded_at end,
  packed_on=case when p_step='packed' then case when p_done then p_on else null end else packed_on end,
  shipped_on=case when p_step='shipped' then case when p_done then p_on else null end else shipped_on end
 where id=p_item_id returning * into result;
 return result;
end $function$
;

CREATE OR REPLACE FUNCTION app.set_work_progress(p_item_id uuid, p_step text, p_done boolean DEFAULT true)
 RETURNS app.items
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_item app.items;
begin
  if auth.uid() is null then raise exception 'ログインが必要です' using errcode='42501'; end if;
  if p_step not in ('registered','inspected','photo','packed','shipped') then
    raise exception '作業項目を確認してください' using errcode='22023';
  end if;
  perform app.assert_can_work_on(p_item_id);
  if p_done and p_step in ('packed','shipped') then perform app.require_photo_review(p_item_id); end if;
  update app.items set
    product_registered_at = case when p_step='registered' then case when p_done then now() else null end else product_registered_at end,
    inspected_at = case when p_step='inspected' then case when p_done then now() else null end else inspected_at end,
    photo_uploaded_at = case when p_step='photo' then case when p_done then now() else null end else photo_uploaded_at end,
    packed_on = case when p_step='packed' then case when p_done then current_date else null end else packed_on end,
    shipped_on = case when p_step='shipped' then case when p_done then current_date else null end else shipped_on end
  where id=p_item_id returning * into v_item;
  return v_item;
end $function$
;

CREATE OR REPLACE FUNCTION app.items_sync_status()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'app'
AS $function$
begin
  if new.status in ('返品処理', '販売済') then return new; end if;
  new.status := case when new.shipped_on is not null then '出品中' else '作業中' end;
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION app.apply_amazon_sale(p_account text, p_transaction text, p_sku text, p_asin text, p_sold_on date, p_price bigint, p_payout bigint, p_actor uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare inventory app.items%rowtype; previous app.amazon_sale_matches%rowtype; evidence jsonb;
  target_id uuid; target_count integer; serial_key text; root_serial text;
begin
  if not exists(select 1 from app.profiles p join app.staff s on s.id=p.staff_id where p.user_id=p_actor and s.role='admin' and s.is_active) then raise exception 'Administrator required'; end if;
  if p_sold_on is null or p_sold_on>(now() at time zone 'Asia/Tokyo')::date or p_price is null or p_payout is null or p_price<0 or p_payout<0 then raise exception 'Invalid sale'; end if;
  select t.item_breakdowns into evidence from app.amazon_payment_transactions t
   where t.account_key=p_account and t.transaction_id=p_transaction and t.marketplace_id='A1VC38T7YXB528' and t.transaction_type='Shipment' and t.status='RELEASED';
  if evidence is null or (select count(*) from jsonb_array_elements(evidence) e where e->>'sku'=p_sku)<>1
    or not exists(select 1 from jsonb_array_elements(evidence) e where e->>'sku'=p_sku and e->>'currency'='JPY' and (e->>'quantity')::numeric=1 and (e->>'amount')::numeric=p_payout) then
    return jsonb_build_object('status','review','reason','確定した商品別金額の根拠がありません。');
  end if;
  serial_key:=app.product_serial(p_sku,null);
  root_serial:=(regexp_match(p_sku,'^([0-9]+)'))[1];
  if serial_key is null then return jsonb_build_object('status','review','reason','SKUの商品番号を読み取れません。'); end if;
  -- Any returned row wins over the original SKU, even when Amazon reports only
  -- the numeric SKU. Suffix depth orders 100, 100a, 100aa chronologically.
  select id into target_id from app.items
   where not is_accessory and (regexp_match(sku,'^([0-9]+)'))[1]=root_serial
     and (marketplace = 'Amazon返品' or amazon_returned_on is not null or returned_on is not null or status in ('Amazon返品','返品処理'))
   order by length(regexp_replace(app.product_serial(sku,lot_seq),'^[0-9]+','')) desc,
            coalesce(amazon_returned_on,returned_on) desc nulls last, updated_at desc, id desc
   limit 1;
  if target_id is null then
    select id into target_id from app.items where sku=p_sku and not is_accessory order by id limit 1;
  end if;
  if target_id is null then
    select count(*),min(id::text)::uuid into target_count,target_id from app.items
      where app.product_serial(sku,lot_seq)=serial_key and not is_accessory;
    if target_count<>1 then target_id:=null; end if;
  end if;
  if target_id is null then return jsonb_build_object('status','review','reason','一致するSKU・返品在庫が見つかりません。'); end if;
  select * into inventory from app.items where id=target_id for update;
  serial_key:=app.product_serial(inventory.sku,inventory.lot_seq);
  perform pg_advisory_xact_lock(hashtextextended(serial_key,179049));
  if inventory.asin is not null and p_asin is not null and inventory.asin<>p_asin then return jsonb_build_object('status','review','reason','在庫とAmazonのASINが一致しません。'); end if;
  if inventory.sales_channel is not null and inventory.sales_channel not in ('FBA','自己発送') then return jsonb_build_object('status','review','reason','在庫の販売先がAmazon以外です。'); end if;
  if (inventory.purchased_at is not null and inventory.purchased_at>p_sold_on) then return jsonb_build_object('status','review','reason','仕入日より前の販売のため確認が必要です。'); end if;
  select * into previous from app.amazon_sale_matches where item_id=inventory.id;
  if found then
    if previous.account_key<>p_account or previous.transaction_id<>p_transaction or previous.sku<>p_sku then return jsonb_build_object('status','review','reason','この在庫には別のAmazon取引が反映済みです。'); end if;
    if inventory.sold_on is distinct from previous.sold_on or inventory.sold_price is distinct from previous.sold_price or inventory.payout_amount is distinct from previous.payout_amount then return jsonb_build_object('status','review','reason','反映後に手動変更されています。自動上書きしません。'); end if;
    if previous.sold_on=p_sold_on and previous.sold_price=p_price and previous.payout_amount=p_payout then return jsonb_build_object('status','unchanged','reason','同じ内容を反映済みです。'); end if;
  elsif inventory.sold_on is not null or inventory.sold_price is not null or inventory.payout_amount is not null then
    return jsonb_build_object('status','review','reason','対象の返品行に既存の販売記録があります。上書きしません。');
  end if;
  update app.items set sold_on=p_sold_on,sold_price=p_price,payout_amount=p_payout,status='販売済' where id=inventory.id;
  insert into app.amazon_sale_matches(item_id,account_key,transaction_id,sku,sold_on,sold_price,payout_amount,applied_by) values(inventory.id,p_account,p_transaction,p_sku,p_sold_on,p_price,p_payout,p_actor)
   on conflict(item_id) do update set sold_on=excluded.sold_on,sold_price=excluded.sold_price,payout_amount=excluded.payout_amount,applied_by=excluded.applied_by,applied_at=now();
  return jsonb_build_object('status','applied','reason','販売日・販売価格・振込額を返品後の在庫行に反映しました。','item_id',inventory.id);
end; $function$
;

CREATE OR REPLACE FUNCTION app.guard_single_product_sale()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare serial_key text;
begin
  if TG_OP='UPDATE' and new.sold_on is not distinct from old.sold_on
    and new.sold_price is not distinct from old.sold_price
    and new.payout_amount is not distinct from old.payout_amount then
    return new;
  end if;
  if new.sold_on is null
     or (new.is_accessory and coalesce(new.sold_price,0)=0 and coalesce(new.payout_amount,0)=0) then
    return new;
  end if;
  serial_key:=app.product_serial(new.sku,new.lot_seq);
  perform pg_advisory_xact_lock(hashtextextended(serial_key,179049));
  if exists (
    select 1 from app.items i
    where app.product_serial(i.sku,i.lot_seq)=serial_key
      and i.id<>new.id
      and i.sold_on is not null
      and not (i.is_accessory and coalesce(i.sold_price,0)=0 and coalesce(i.payout_amount,0)=0)
      and i.amazon_returned_on is null
      and i.returned_on is null
      and i.marketplace is distinct from 'Amazon返品'
      and i.status not in ('Amazon返品','返品処理')
  ) then
    raise exception '同じ商品番号の商品に販売記録があります。返品処理済みの履歴は保持し、重複販売を防止します。';
  end if;
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION app.redirect_accessory_shared_edits()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare parent app.items%rowtype; parent_count integer;
begin
  if pg_trigger_depth() > 1 or not old.is_accessory or not new.is_accessory then return new; end if;
  if not (
    new.status is distinct from old.status or new.packed_on is distinct from old.packed_on
    or new.shipped_on is distinct from old.shipped_on or new.returned_on is distinct from old.returned_on
    or new.sales_channel is distinct from old.sales_channel or new.sold_on is distinct from old.sold_on
    or new.sold_price is distinct from old.sold_price or new.payout_amount is distinct from old.payout_amount
  ) then return new; end if;
  select count(*) into parent_count from app.items i
   where not i.is_accessory and i.lot_seq=new.lot_seq
     and app.product_serial(i.sku,i.lot_seq)=app.product_serial(new.sku,new.lot_seq);
  -- A standalone sold accessory has no shared parent to update. Permit only
  -- an authenticated administrator to fill its blank historical work dates.
  if parent_count=0 and auth.uid() is not null and coalesce(app.is_admin(),false)
    and old.status='販売済' and new.status=old.status
    and (old.packed_on is null or new.packed_on is not distinct from old.packed_on)
    and (old.shipped_on is null or new.shipped_on is not distinct from old.shipped_on)
    and new.packed_on is not null and new.shipped_on is not null
    and new.packed_on<=new.shipped_on
    -- The generated profit column is evaluated after BEFORE triggers.
    and (to_jsonb(new)-array['packed_on','shipped_on','packed_completed_at','updated_at','profit'])
      is not distinct from
      (to_jsonb(old)-array['packed_on','shipped_on','packed_completed_at','updated_at','profit']) then
    return new;
  end if;
  if parent_count <> 1 then raise exception '対応する本体を一意に特定できません。通番号とSKUを確認してください'; end if;
  select i.* into parent from app.items i
   where not i.is_accessory and i.lot_seq=new.lot_seq
     and app.product_serial(i.sku,i.lot_seq)=app.product_serial(new.sku,new.lot_seq)
   for update;
  update app.items i set
    status=case when new.status is distinct from old.status then new.status else parent.status end,
    packed_on=case when new.packed_on is distinct from old.packed_on then new.packed_on else parent.packed_on end,
    shipped_on=case when new.shipped_on is distinct from old.shipped_on then new.shipped_on else parent.shipped_on end,
    returned_on=case when new.returned_on is distinct from old.returned_on then new.returned_on else parent.returned_on end,
    sales_channel=case when new.sales_channel is distinct from old.sales_channel then new.sales_channel else parent.sales_channel end,
    sold_on=case when new.sold_on is distinct from old.sold_on then new.sold_on else parent.sold_on end,
    sold_price=case when new.sold_price is distinct from old.sold_price then new.sold_price else parent.sold_price end,
    payout_amount=case when new.payout_amount is distinct from old.payout_amount then new.payout_amount else parent.payout_amount end
  where i.id=parent.id;
  select i.* into parent from app.items i where i.id=parent.id;
  new.status:=parent.status;
  new.packed_on:=parent.packed_on;
  new.shipped_on:=parent.shipped_on;
  new.returned_on:=parent.returned_on;
  new.sales_channel:=parent.sales_channel;
  new.sold_on:=parent.sold_on;
  new.sold_price:=null;
  new.payout_amount:=null;
  return new;
end;
$function$

;

drop trigger items_sync_status on app.items;
create trigger items_sync_status before insert or update of status, product_registered_at,
  inspected_at, cleaned_at, photo_uploaded_at, packed_on, shipped_on, listed_on, amazon_returned_on
  on app.items for each row execute function app.items_sync_status();

do $$ begin
  if exists(select 1 from app.items where status in ('保留','廃棄')) then
    raise exception 'Retired states contain data; reconcile before removing';
  end if;
end $$;
alter table app.items add constraint items_no_hold_or_discard
  check(status not in ('保留','廃棄'));

-- Remove discarded-state exclusions without changing other stock logic.
do $$ declare rec record; definition text; begin
  for rec in select v.viewname,c.reloptions from pg_views v join pg_class c
    on c.oid=('app.'||v.viewname)::regclass where v.schemaname='app' and v.definition like '%廃棄%' loop
    definition := pg_get_viewdef(('app.'||rec.viewname)::regclass,true);
    definition := replace(definition,', ''廃棄''::app.item_status','');
    definition := replace(definition,'''廃棄''::app.item_status, ','');
    if position('廃棄' in definition)>0 then raise exception 'Unexpected view: %',rec.viewname; end if;
    execute 'create or replace view app.'||quote_ident(rec.viewname)||case when rec.reloptions is null then ''
      else ' with ('||array_to_string(rec.reloptions,',')||')' end||' as '||definition;
  end loop;
end $$;

-- Explicitly rebuild only the five dependent views, without CASCADE, retaining
-- owner, security options, comments and original grants.
create temporary table arrival_views_before on commit drop as
select c.relname,c.relowner,c.reloptions,c.relacl,pg_get_viewdef(c.oid,true) as definition,
  obj_description(c.oid,'pg_class') as comment,
  case c.relname when 'v_items' then 1 when 'v_deliverer_workload' then 2
    when 'v_delivery_tasks' then 3 when 'v_inventory_items' then 4
    when 'v_inventory_display' then 5 end as ordinal
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='app' and c.relname in
  ('v_items','v_deliverer_workload','v_delivery_tasks','v_inventory_items','v_inventory_display');

do $$ declare rec record; begin
  if (select count(*) from arrival_views_before)<>5 then raise exception 'Expected five arrival views'; end if;
  for rec in select * from arrival_views_before order by ordinal desc loop
    execute 'drop view app.'||quote_ident(rec.relname);
  end loop;
end $$;
alter table app.items drop column arrived_on;

do $$ declare rec record; privilege_rec record; new_role record; definition text; target text; begin
  for rec in select * from arrival_views_before order by ordinal loop
    definition := regexp_replace(rec.definition,'[ \t]*(i|inventory)\.arrived_on,\n','','g');
    if rec.relname='v_deliverer_workload' then
      definition := $view$
        select s.id as deliverer_id,s.name as deliverer_name,
          count(*) filter(where i.status='作業中') as 作業中,
          count(*) filter(where i.shipped_on>=date_trunc('month',current_date::timestamptz)) as 今月出荷,
          count(*) filter(where i.status='作業中') as 手元在庫,
          avg(i.shipped_on-i.purchased_at) filter(where i.shipped_on is not null and i.purchased_at is not null)::numeric(10,1) as 平均作業日数
        from app.staff s join app.items i on i.deliverer_id=s.id where s.is_active
        group by s.id,s.name order by count(*) filter(where i.status='作業中') desc
      $view$;
    end if;
    if position('arrived_on' in definition)>0 then raise exception 'Arrival reference remains: %',rec.relname; end if;
    target := 'app.'||quote_ident(rec.relname);
    execute 'create view '||target||case when rec.reloptions is null then ''
      else ' with ('||array_to_string(rec.reloptions,',')||')' end||' as '||definition;
    execute 'alter view '||target||' owner to '||quote_ident(pg_get_userbyid(rec.relowner));
    -- Remove newly inherited default grants before restoring the originals.
    for new_role in select distinct a.grantee from pg_class c,
      lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
      where c.oid=target::regclass and a.grantee<>rec.relowner loop
      execute 'revoke all on '||target||' from '||case when new_role.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(new_role.grantee)) end;
    end loop;
    execute 'revoke all on '||target||' from PUBLIC';
    for privilege_rec in select * from aclexplode(coalesce(rec.relacl,acldefault('r',rec.relowner))) where grantee<>rec.relowner loop
      execute 'grant '||privilege_rec.privilege_type||' on '||target||' to '||
        case when privilege_rec.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(privilege_rec.grantee)) end||
        case when privilege_rec.is_grantable then ' with grant option' else '' end;
    end loop;
    if rec.comment is not null then execute 'comment on view '||target||' is '||quote_literal(rec.comment); end if;
  end loop;
end $$;
