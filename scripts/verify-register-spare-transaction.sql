begin;
do $$
declare aa uuid; ii uuid; user_aa uuid; user_ii uuid; spare uuid; collision uuid; lot integer;
  result jsonb; body app.items; accessory app.items; payload jsonb; count_before integer;
begin
  select id into aa from app.staff where code='AA';
  select id into ii from app.staff where code='II';
  select user_id into user_aa from app.profiles where staff_id=aa limit 1;
  select user_id into user_ii from app.profiles where staff_id=ii limit 1;
  select max(seq)+1000 into lot from app.lots;
  insert into app.spare_accessories(owner_staff_id,title,cost_amount,purchased_at,marketplace,marketplace_item_id,tracking_no)
    values(aa,'検証リモコン',1230,'2026-09-01','ヤフオク','spare-id','spare-tracking') returning id into spare;
  insert into app.spare_accessories(owner_staff_id,title,cost_amount,purchased_at,marketplace)
    values(aa,'衝突検証',43210,'2026-10-07','メルカリ') returning id into collision;
  payload:=jsonb_build_object('lot_seq',lot,'purchaser_id',aa,'deliverer_id',ii,'work_stream','ブルーレイ',
    'purchased_at','2026-10-07','title','本体の型番','asin','B000000001','cost_amount',43210,
    'marketplace','メルカリ','marketplace_item_id','body-id','tracking_no','body-tracking','sales_channel','FBA');
  perform set_config('request.jwt.claim.sub',user_aa::text,true);
  set local role authenticated;
  result:=app.register_item_with_spare(payload,spare);
  select * into body from app.items where id=(result->>'id')::uuid;
  select * into accessory from app.items where sku=result->>'accessory_sku';
  if body.title<>'本体の型番' or body.cost_amount<>43210 or body.marketplace_item_id<>'body-id' or body.tracking_no<>'body-tracking'
    or body.asin<>'B000000001' or body.is_accessory then raise exception 'Main information changed'; end if;
  if not accessory.is_accessory or accessory.lot_seq<>body.lot_seq or accessory.title<>'検証リモコン'
    or accessory.cost_amount<>1230 or accessory.purchased_at<>'2026-09-01' or accessory.marketplace_item_id<>'spare-id'
    or accessory.tracking_no<>'spare-tracking' or accessory.deliverer_id<>ii then raise exception 'Accessory incorrect'; end if;
  if (select used_for_item_id from app.spare_accessories where id=spare)<>body.id then raise exception 'Spare not allocated'; end if;
  select count(*) into count_before from app.items;
  begin
    perform app.register_item_with_spare(payload || jsonb_build_object('lot_seq',lot+1),spare);
    raise exception 'Used spare accepted';
  exception when sqlstate '22023' then null; end;
  if (select count(*) from app.items)<>count_before then raise exception 'Partial duplicate persisted'; end if;
  -- Duplicate SKU on the second row must roll back the main row and allocation.
  begin
    perform app.register_item_with_spare(payload || jsonb_build_object('lot_seq',lot+2),collision);
    raise exception 'Expected duplicate SKU';
  exception when unique_violation then null; end;
  if exists(select 1 from app.items where lot_seq=lot+2)
    or (select used_for_item_id from app.spare_accessories where id=collision) is not null then raise exception 'Partial registration persisted'; end if;
  perform set_config('request.jwt.claim.sub',user_ii::text,true);
  begin
    perform app.register_item_with_spare(payload,collision);
    raise exception 'Deliverer could register inventory';
  exception when insufficient_privilege then null; end;
  if has_function_privilege('anon','app.register_item_with_spare(jsonb,uuid)','EXECUTE') then raise exception 'Anonymous access'; end if;
  reset role;
end;
$$;
rollback;
