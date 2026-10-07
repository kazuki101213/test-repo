-- No HTTP dispatch. Every fixture, source edit and task transition rolls back.
begin;
do $$
declare aa uuid; ee uuid; mm uuid; ii uuid; ua uuid; ue uuid; um uuid; ui uuid;
  spare uuid; same_spare uuid; lot integer; result jsonb; body app.items; accessory app.items;
  task app.spare_shipping_tasks; payload jsonb; original_tracking text; task_count integer;
begin
  select id into aa from app.staff where code='AA';
  select id into ee from app.staff where code='EE';
  select id into mm from app.staff where code='MM';
  select id into ii from app.staff where code='II';
  select user_id into strict ua from app.profiles where staff_id=aa;
  select user_id into strict ue from app.profiles where staff_id=ee;
  select user_id into strict um from app.profiles where staff_id=mm;
  select user_id into strict ui from app.profiles where staff_id=ii;
  select max(seq)+2000 into lot from app.lots;
  insert into app.spare_accessories(owner_staff_id,title,manufacturer,cost_amount,purchased_at,marketplace,
    marketplace_item_id,tracking_no,usage_note)
  values(ee,'検証リモコン','Panasonic純正',1500,'2026-05-26','メルカリ','shipping-fixture','purchase-tracking','1647 / 1723')
    returning id into spare;
  insert into app.spare_accessories(owner_staff_id,title,cost_amount,purchased_at,marketplace,marketplace_item_id)
    values(mm,'同担当者の予備',500,'2026-05-26','メルカリ','same-owner') returning id into same_spare;
  payload:=jsonb_build_object('lot_seq',lot,'purchaser_id',aa,'deliverer_id',mm,'work_stream','ブルーレイ',
    'purchased_at','2026-10-07','title','本体の型番','cost_amount',5900,'marketplace','ヤフオク',
    'marketplace_item_id','body-fixture','tracking_no','body-tracking','sales_channel','FBA');
  perform set_config('request.jwt.claim.sub',ua::text,true);
  set local role authenticated;
  result:=app.register_item_with_spare(payload,spare);
  select * into strict body from app.items where id=(result->>'id')::uuid;
  select * into strict accessory from app.items where sku=result->>'accessory_sku';
  select * into strict task from app.spare_shipping_tasks where spare_id=spare;
  if task.item_id<>body.id or task.accessory_item_id<>accessory.id or task.owner_staff_id<>ee
    or task.recipient_staff_id<>mm or task.title<>'検証リモコン' or task.manufacturer<>'Panasonic純正'
    or task.usage_note<>'1647 / 1723' or task.sent_at is not null then raise exception 'Incorrect source/target linkage'; end if;
  begin perform app.complete_spare_shipping(task.id); raise exception 'Unsent task completed';
  exception when sqlstate '22023' then null; end;
  -- Repeated enqueue is idempotent.
  perform app.queue_spare_shipping(spare,body.id,accessory.id);
  if (select count(*) from app.spare_shipping_tasks where spare_id=spare)<>1 then raise exception 'Duplicate tasks'; end if;
  -- Same holder/deliverer must not create shipping.
  result:=app.register_item_with_spare(payload || jsonb_build_object('lot_seq',lot+1),same_spare);
  if exists(select 1 from app.spare_shipping_tasks where spare_id=same_spare) then raise exception 'Same-owner task created'; end if;
  -- Wrong account cannot see or ship it, including the recipient.
  perform set_config('request.jwt.claim.sub',ui::text,true);
  if exists(select 1 from app.v_spare_shipping_tasks where id=task.id) then raise exception 'Unrelated account can read'; end if;
  begin perform app.send_spare_shipping(task.id,'wrong'); raise exception 'Unrelated account sent';
  exception when insufficient_privilege then null; end;
  perform set_config('request.jwt.claim.sub',um::text,true);
  begin perform app.send_spare_shipping(task.id,'wrong'); raise exception 'Recipient sent';
  exception when insufficient_privilege then null; end;
  -- Holder can see all requested details even without access to recipient inventory.
  perform set_config('request.jwt.claim.sub',ue::text,true);
  if not exists(select 1 from app.v_spare_shipping_tasks where id=task.id and recipient_code='MM') then
    raise exception 'Holder cannot read task'; end if;
  begin perform app.send_spare_shipping(task.id,'   '); raise exception 'Blank tracking accepted';
  exception when sqlstate '22023' then null; end;
  begin perform app.complete_spare_shipping(task.id); raise exception 'Holder completed admin task';
  exception when insufficient_privilege then null; end;
  perform app.send_spare_shipping(task.id,'  new-shipping-tracking  ');
  perform app.send_spare_shipping(task.id,'new-shipping-tracking');
  begin perform app.send_spare_shipping(task.id,'different'); raise exception 'Sent tracking overwritten';
  exception when sqlstate '22023' then null; end;
  reset role;
  if (select tracking_no from app.items where id=accessory.id)<>'new-shipping-tracking'
    or (select tracking_no from app.items where id=body.id)<>'body-tracking'
    or (select tracking_no from app.spare_accessories where id=spare)<>'purchase-tracking' then
    raise exception 'Tracking changed the wrong source or item'; end if;
  if not exists(select 1 from app.spare_shipping_tasks where id=task.id and sent_at is not null
    and completed_at is null and tracking_no='new-shipping-tracking') then raise exception 'Sent state missing'; end if;
  perform set_config('request.jwt.claim.sub',ua::text,true);
  set local role authenticated;
  perform app.complete_spare_shipping(task.id);
  if exists(select 1 from app.v_spare_shipping_tasks where id=task.id and completed_at is null) then
    raise exception 'Completed task remains visible'; end if;
  reset role;
  if not exists(select 1 from app.spare_shipping_tasks where id=task.id and completed_at is not null) then
    raise exception 'History removed'; end if;
  if has_table_privilege('anon','app.spare_shipping_tasks','SELECT')
    or has_function_privilege('anon','app.send_spare_shipping(uuid,text)','EXECUTE') then
    raise exception 'Anonymous access'; end if;
end $$;
select 'Registration, same owner, exact linkage, RLS, tracking isolation, retry and completion passed' as result;
rollback;
