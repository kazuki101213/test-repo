-- Preserve full serial identity; store the physical delivery holder for generated spares.
create or replace function app.move_inventory_accessory_to_spares(
  p_item_id uuid,
  p_spare_input jsonb
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item app.items%rowtype;
  v_spare_id uuid;
  v_owner_id uuid;
  v_owner_name text;
  v_registered_serial text;
begin
  if auth.uid() is null or app.current_role() not in ('admin','purchaser') then
    raise exception '予備一覧へ登録する権限がありません' using errcode='42501';
  end if;
  if p_spare_input is null or jsonb_typeof(p_spare_input) <> 'object' then
    raise exception 'リモコン情報が不正です' using errcode='22023';
  end if;

  select * into v_item from app.items where id=p_item_id for update;
  if not found then raise exception '在庫一覧のリモコン行が見つかりません' using errcode='P0002'; end if;
  if not v_item.is_accessory or v_item.title not ilike '%リモコン%' then
    raise exception '対象は付属品登録されたリモコン行ではありません' using errcode='22023';
  end if;
  if app.current_role() = 'purchaser' and v_item.purchaser_id is distinct from app.current_staff_id() then
    raise exception '担当外のリモコン行は移動できません' using errcode='42501';
  end if;
  if coalesce(p_spare_input->>'usage_note','') !~ '^[0-9]+[a-z]*$' then
    raise exception '利用記録に通番号を入力してください' using errcode='22023';
  end if;
  v_registered_serial := upper(p_spare_input->>'usage_note');
  if v_registered_serial is distinct from app.product_serial(v_item.sku,v_item.lot_seq) then
    raise exception '入力した通番号と在庫行の通番号が一致しません' using errcode='22023';
  end if;

  v_owner_id := coalesce(nullif(p_spare_input->>'owner_staff_id','')::uuid, v_item.deliverer_id, v_item.purchaser_id, app.current_staff_id());
  if app.current_role() = 'purchaser' and v_owner_id is distinct from app.current_staff_id() and v_owner_id is distinct from v_item.deliverer_id then
    raise exception '保管担当者には自分または商品の納品担当者を指定してください' using errcode='42501';
  end if;
  select name into v_owner_name from app.staff where id=v_owner_id;
  v_owner_name := coalesce(nullif(btrim(p_spare_input->>'owner_name'),''),v_owner_name);
  if nullif(btrim(p_spare_input->>'title'),'') is null then
    raise exception '品名を入力してください' using errcode='22023';
  end if;
  if coalesce(nullif(p_spare_input->>'cost_amount','')::bigint,v_item.cost_amount) < 0 then
    raise exception '仕入金額は0円以上で入力してください' using errcode='22023';
  end if;

  insert into app.spare_accessories (
    source_sku,owner_staff_id,owner_name,purchased_at,title,manufacturer,model_no,asin,
    cost_amount,marketplace,marketplace_item_id,tracking_no,usage_note
  ) values (
    coalesce(nullif(p_spare_input->>'source_sku',''),v_item.sku),
    v_owner_id,v_owner_name,
    coalesce(nullif(p_spare_input->>'purchased_at','')::date,v_item.purchased_at),
    btrim(p_spare_input->>'title'),
    nullif(btrim(p_spare_input->>'manufacturer'),''),
    nullif(btrim(p_spare_input->>'model_no'),''),
    nullif(btrim(p_spare_input->>'asin'),''),
    coalesce(nullif(p_spare_input->>'cost_amount','')::bigint,v_item.cost_amount),
    nullif(p_spare_input->>'marketplace',''),
    nullif(p_spare_input->>'marketplace_item_id',''),
    nullif(p_spare_input->>'tracking_no',''),
    p_spare_input->>'usage_note'
  ) returning id into v_spare_id;

  delete from app.items where id=v_item.id;
  return v_spare_id;
end;
$$;

revoke all on function app.move_inventory_accessory_to_spares(uuid,jsonb) from public,anon;
grant execute on function app.move_inventory_accessory_to_spares(uuid,jsonb) to authenticated;

create or replace function app.prepare_yahoo_auction_item(p_item_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_body app.items%rowtype;
  v_remote app.items%rowtype;
  v_remote_count integer;
  v_owner_id uuid;
  v_owner_name text;
  v_model_no text;
  v_maker text;
  v_serial text;
begin
  if auth.uid() is null or app.current_role() not in ('admin','purchaser') then
    raise exception 'ヤフオク販売の準備を行う権限がありません' using errcode='42501';
  end if;

  select * into v_body from app.items where id=p_item_id for update;
  if not found then raise exception '対象の在庫行が見つかりません' using errcode='P0002'; end if;
  if v_body.is_accessory then raise exception '本体の在庫行を選択してください' using errcode='22023'; end if;
  if app.current_role() = 'purchaser' and v_body.purchaser_id is distinct from app.current_staff_id() then
    raise exception '担当外の商品はヤフオク販売に設定できません' using errcode='42501';
  end if;

  v_serial := lower(app.product_serial(v_body.sku,v_body.lot_seq));

  if exists (
    select 1 from app.spare_accessories s
    where lower(btrim(s.usage_note))=v_serial and s.title ilike '%リモコン%'
  ) then
  update app.items set sales_channel='ヤフオク'::app.sales_channel, updated_at=now() where id=v_body.id;
    return;
  end if;

  select count(*) into v_remote_count from app.items i
  where app.product_serial(i.sku,i.lot_seq)=app.product_serial(v_body.sku,v_body.lot_seq) and i.is_accessory and i.title ilike '%リモコン%';
  if v_remote_count > 1 then
    raise exception '通番号 % のリモコン行が複数あります。在庫一覧を確認してください。', v_serial using errcode='22023';
  end if;

  if v_remote_count = 1 then
    select * into v_remote from app.items i
    where app.product_serial(i.sku,i.lot_seq)=app.product_serial(v_body.sku,v_body.lot_seq) and i.is_accessory and i.title ilike '%リモコン%'
    limit 1 for update;
    select p.model_no,p.maker into v_model_no,v_maker from app.products p where p.id=v_remote.product_id;
    v_owner_id := coalesce(v_body.deliverer_id,v_remote.deliverer_id,v_remote.purchaser_id,v_body.purchaser_id,app.current_staff_id());
    select s.name into v_owner_name from app.staff s where s.id=v_owner_id;
    perform app.move_inventory_accessory_to_spares(v_remote.id,jsonb_build_object(
      'source_sku',v_remote.sku,
      'owner_staff_id',v_owner_id,
      'owner_name',v_owner_name,
      'purchased_at',v_remote.purchased_at,
      'title',v_remote.title,
      'manufacturer',v_maker,
      'model_no',v_model_no,
      'asin',v_remote.asin,
      'cost_amount',v_remote.cost_amount,
      'marketplace',v_remote.marketplace,
      'marketplace_item_id',v_remote.marketplace_item_id,
      'tracking_no',v_remote.tracking_no,
      'usage_note',v_serial
    ));
  else
    select p.model_no,p.maker into v_model_no,v_maker from app.products p where p.id=v_body.product_id;
    v_owner_id := coalesce(v_body.deliverer_id,v_body.purchaser_id,app.current_staff_id());
    select s.name into v_owner_name from app.staff s where s.id=v_owner_id;
    insert into app.spare_accessories (
      source_sku,owner_staff_id,owner_name,purchased_at,title,manufacturer,model_no,asin,
      cost_amount,marketplace,marketplace_item_id,tracking_no,usage_note
    ) values (
      null,v_owner_id,v_owner_name,v_body.purchased_at,'リモコン',v_maker,v_model_no,v_body.asin,
      0,v_body.marketplace,v_body.marketplace_item_id,v_body.tracking_no,v_serial
    );
  end if;
  -- Move the remote before the body update synchronizes and replaces its SKU.
  update app.items set sales_channel='ヤフオク'::app.sales_channel, updated_at=now() where id=v_body.id;
end;
$$;

revoke all on function app.prepare_yahoo_auction_item(uuid) from public, anon;
grant execute on function app.prepare_yahoo_auction_item(uuid) to authenticated;

-- Keep explicit spare manufacturers; infer missing ones from the exact body serial.
create or replace function app.fill_spare_body_manufacturer() returns trigger
language plpgsql security invoker set search_path='' as $$
declare serial text; maker text;
begin
 if nullif(btrim(new.manufacturer),'') is not null then return new; end if;
 serial:=lower(btrim(regexp_replace(coalesce(new.usage_note,''),'リモコン','','g')));
 if serial !~ '^[0-9]+[a-z]*$' then return new; end if;
 select coalesce(nullif(btrim(p.maker),''),nullif(btrim(ap.maker),'')) into maker
 from app.items i left join app.products p on p.id=i.product_id
 left join app.products ap on ap.asin=i.asin
 where not i.is_accessory and lower(app.product_serial(i.sku,i.lot_seq))=serial
 order by i.created_at desc,i.id limit 1;
 if maker is not null then new.manufacturer:=maker; end if;
 return new;
end $$;
revoke all on function app.fill_spare_body_manufacturer() from public,anon,authenticated;
create trigger spare_body_manufacturer before insert or update of usage_note,manufacturer,source_sku
 on app.spare_accessories for each row execute function app.fill_spare_body_manufacturer();

-- Repair only the two usage records identified by the user, preserving source SKUs and purchase costs.
update app.spare_accessories s set manufacturer=coalesce(nullif(btrim(p.maker),''),nullif(btrim(ap.maker),'')),updated_at=now()
from app.items i left join app.products p on p.id=i.product_id left join app.products ap on ap.asin=i.asin
where not i.is_accessory and lower(app.product_serial(i.sku,i.lot_seq))=lower(btrim(s.usage_note))
 and lower(btrim(s.usage_note)) in ('2395','2398') and nullif(btrim(s.manufacturer),'') is null;
update app.spare_accessories s set owner_staff_id=i.deliverer_id,owner_name=staff.name,updated_at=now()
from app.items i join app.staff staff on staff.id=i.deliverer_id
where not i.is_accessory and lower(app.product_serial(i.sku,i.lot_seq))='2398'
 and lower(btrim(s.usage_note))='2398' and s.used_for_item_id is null
 and (s.owner_staff_id is distinct from i.deliverer_id or s.owner_name is distinct from staff.name);
notify pgrst,'reload schema';
