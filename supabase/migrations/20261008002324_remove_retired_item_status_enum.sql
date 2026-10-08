-- Replace the enum transactionally; preserve every item's data and permissions.
set local lock_timeout='5s';
create temporary table status_items_before on commit drop as select id,to_jsonb(i) as value from app.items i;
create temporary table status_type_before on commit drop as
select typowner,typacl,obj_description(oid,'pg_type') as comment from pg_type where oid='app.item_status'::regtype;
do $$ begin
 if exists(select 1 from app.items where status::text not in ('作業中','出品中','販売済','返品処理')) then
   raise exception 'Legacy status data requires reconciliation';end if;
end $$;
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
     and (marketplace = 'Amazon返品' or amazon_returned_on is not null or returned_on is not null or status='返品処理')
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
      and i.status<>'返品処理'
  ) then
    raise exception '同じ商品番号の商品に販売記録があります。返品処理済みの履歴は保持し、重複販売を防止します。';
  end if;
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION app.enforce_amazon_return_main_item()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  numeric_serial text;
  separator_and_tail text;
  requested_depth integer;
  existing_depth integer;
  next_depth integer;
begin
  if new.marketplace::text <> 'Amazon返品' then
    return new;
  end if;

  -- A reserve recovered from an Amazon return remains an accessory when
  -- registered together with its explicitly allocated main item. All source
  -- identity fields must match; ordinary return registrations stay main items.
  if tg_op = 'INSERT' and new.is_accessory and new.work_stream::text = '付属品'
    and auth.uid() is not null and app.current_role() in ('admin','purchaser')
    and exists (
      select 1 from app.spare_accessories s join app.items i on i.id=s.used_for_item_id
      where not i.is_accessory and i.lot_seq=new.lot_seq
        and i.created_by=app.current_staff_id()
        and i.deliverer_id is not distinct from new.deliverer_id
        and s.title is not distinct from new.title
        and s.marketplace_item_id is not distinct from new.marketplace_item_id
        and s.asin is not distinct from new.asin
        and s.cost_amount is not distinct from new.cost_amount
        and s.purchased_at is not distinct from new.purchased_at
        and new.purchaser_id is not distinct from coalesce(s.owner_staff_id,i.purchaser_id)
        and (app.is_admin() or s.owner_staff_id=app.current_staff_id())
    ) then return new; end if;

  if tg_op <> 'INSERT' then
    if new.amazon_returned_on is not null then
      new.is_accessory := false;
    end if;
    return new;
  end if;

  new.is_accessory := false;

  numeric_serial := (regexp_match(new.sku, '^([0-9]+)'))[1];
  separator_and_tail := substring(new.sku from '^[0-9]+[a-z]*([-_].*)$');
  if numeric_serial is null or separator_and_tail is null then
    return new;
  end if;

  -- Serialize return registrations for a product so concurrent submissions
  -- cannot receive the same suffix.
  perform pg_advisory_xact_lock(hashtextextended('amazon-return:' || new.lot_seq::text || ':' || numeric_serial, 179049));

  select coalesce(max(length(coalesce((regexp_match(i.sku, '^[0-9]+([a-z]*)[-_]'))[1], ''))), 0)
    into existing_depth
  from app.items i
  where i.lot_seq = new.lot_seq
    and i.marketplace::text = 'Amazon返品'
    and (regexp_match(i.sku, '^([0-9]+)'))[1] = numeric_serial;

  requested_depth := length(coalesce((regexp_match(new.sku, '^[0-9]+([a-z]*)[-_]'))[1], ''));
  next_depth := greatest(existing_depth + 1, requested_depth, 1);
  new.sku := numeric_serial || repeat('a', next_depth) || separator_and_tail;
  return new;
end;
$function$
;

create temporary table status_views_before on commit drop as
with recursive dependent_views(oid,depth) as (
 select r.ev_class,1 from pg_depend d join pg_rewrite r on d.classid='pg_rewrite'::regclass and r.oid=d.objid
 where d.refclassid='pg_class'::regclass and d.refobjid='app.items'::regclass
   and d.refobjsubid=(select attnum from pg_attribute where attrelid='app.items'::regclass and attname='status')
 union all
 select r.ev_class,b.depth+1 from dependent_views b join pg_depend d on d.refclassid='pg_class'::regclass and d.refobjid=b.oid
 join pg_rewrite r on d.classid='pg_rewrite'::regclass and r.oid=d.objid where r.ev_class<>b.oid
), depths as (select oid,max(depth) as depth from dependent_views group by oid)
select c.relname,c.relowner,c.relacl,c.reloptions,pg_get_viewdef(c.oid,true) as definition,
 obj_description(c.oid,'pg_class') as comment,d.depth
from depths d join pg_class c on c.oid=d.oid where c.relnamespace='app'::regnamespace and c.relkind='v';
do $$ declare rec record; begin
 if (select count(*) from status_views_before)<>9 then raise exception 'Expected nine dependent views';end if;
 for rec in select * from status_views_before order by depth desc,relname loop
   execute 'drop view app.'||quote_ident(rec.relname);
 end loop;
end $$;
create temporary table status_triggers_before on commit drop as
select tgname,pg_get_triggerdef(oid) as definition,tgenabled from pg_trigger
where tgrelid='app.items'::regclass and tgname in
 ('items_redirect_accessory_shared_edits','items_sync_accessory_sale_date','items_sync_status');
do $$ declare rec record; begin
 if (select count(*) from status_triggers_before)<>3 then raise exception 'Expected three status triggers';end if;
 for rec in select * from status_triggers_before loop execute 'drop trigger '||quote_ident(rec.tgname)||' on app.items';end loop;
end $$;
alter table app.items drop constraint items_no_hold_or_discard,
 drop constraint items_no_retired_purchase_status,drop constraint items_no_amazon_return_work_status;
alter table app.items alter column status drop default;
create type app.item_status_current as enum ('作業中','出品中','販売済','返品処理');
alter table app.items alter column status type app.item_status_current using status::text::app.item_status_current;
drop type app.item_status;
alter type app.item_status_current rename to item_status;
alter table app.items alter column status set default '作業中'::app.item_status;
do $$ declare saved record; role_rec record; grant_rec record; begin
 select * into saved from status_type_before;
 execute 'alter type app.item_status owner to '||quote_ident(pg_get_userbyid(saved.typowner));
 if saved.typacl is not null then
 for role_rec in select distinct a.grantee from pg_type t,
   lateral aclexplode(coalesce(t.typacl,acldefault('T',t.typowner))) a
   where t.oid='app.item_status'::regtype and a.grantee<>saved.typowner loop
   execute 'revoke all on type app.item_status from '||case when role_rec.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(role_rec.grantee)) end;
 end loop;
 for grant_rec in select * from aclexplode(coalesce(saved.typacl,acldefault('T',saved.typowner))) where grantee<>saved.typowner loop
   execute 'grant '||grant_rec.privilege_type||' on type app.item_status to '||case when grant_rec.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(grant_rec.grantee)) end||case when grant_rec.is_grantable then ' with grant option' else '' end;
 end loop;
 elsif (select typacl is not null from pg_type where oid='app.item_status'::regtype) then
   raise exception 'Unexpected default type grants';
 end if;
 if saved.comment is not null then execute 'comment on type app.item_status is '||quote_literal(saved.comment);end if;
end $$;
do $$ declare rec record; definition text; target text; role_rec record; grant_rec record; begin
 for rec in select * from status_views_before order by depth,relname loop
   definition:=replace(rec.definition,', ''出荷済''::app.item_status','');
   if definition like '%出荷済%' then raise exception 'Legacy shipping state remains: %',rec.relname;end if;
   target:='app.'||quote_ident(rec.relname);
   execute 'create view '||target||case when rec.reloptions is null then '' else ' with ('||array_to_string(rec.reloptions,',')||')' end||' as '||definition;
   execute 'alter view '||target||' owner to '||quote_ident(pg_get_userbyid(rec.relowner));
   for role_rec in select distinct a.grantee from pg_class c,
     lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
     where c.oid=target::regclass and a.grantee<>rec.relowner loop
     execute 'revoke all on '||target||' from '||case when role_rec.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(role_rec.grantee)) end;
   end loop;
   execute 'revoke all on '||target||' from PUBLIC';
   for grant_rec in select * from aclexplode(coalesce(rec.relacl,acldefault('r',rec.relowner))) where grantee<>rec.relowner loop
     execute 'grant '||grant_rec.privilege_type||' on '||target||' to '||case when grant_rec.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(grant_rec.grantee)) end||case when grant_rec.is_grantable then ' with grant option' else '' end;
   end loop;
   if rec.comment is not null then execute 'comment on view '||target||' is '||quote_literal(rec.comment);end if;
 end loop;
 for rec in select * from status_triggers_before loop
   execute rec.definition;
   execute 'alter table app.items '||case rec.tgenabled when 'D' then 'disable' when 'R' then 'enable replica' when 'A' then 'enable always' else 'enable' end||' trigger '||quote_ident(rec.tgname);
 end loop;
end $$;
drop function app.set_work_progress(uuid,text,boolean);
do $$ begin
 if exists(select 1 from app.items i full join status_items_before b using(id) where to_jsonb(i) is distinct from b.value) then
   raise exception 'Inventory data changed during type replacement';end if;
end $$;
notify pgrst,'reload schema';
