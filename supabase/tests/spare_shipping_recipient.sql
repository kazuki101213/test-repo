-- Real allocation / inventory triggers / RLS; fixtures never persist.
begin;
set local request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
do $test$
declare aa uuid; dd uuid; hh uuid; ii uuid; spare uuid; body uuid; accessory uuid; task uuid; second_task uuid;
        result jsonb; old_sent timestamptz; before_owner uuid;
begin
  select id into aa from app.staff where code='AA';
  select id into dd from app.staff where code='DD';
  select id into hh from app.staff where code='HH';
  select id into ii from app.staff where code='II';
  insert into app.spare_accessories(owner_staff_id,title,cost_amount,purchased_at,marketplace,marketplace_item_id)
  values(aa,'recipient regression remote',500,'2026-10-01','ヤフオク','recipient-regression-spare') returning id into spare;
  set local role authenticated;
  result:=app.register_item_with_spare(jsonb_build_object('lot_seq',899995,'purchaser_id',aa,'deliverer_id',dd,
    'purchased_at','2026-10-17','title','recipient regression body','cost_amount',5000,'marketplace','ヤフオク',
    'sales_channel','FBA','work_stream','ブルーレイ'),spare);
  body:=(result->>'id')::uuid;
  select id into strict accessory from app.items where parent_item_id=body;
  select id,owner_staff_id into strict task,before_owner from app.spare_shipping_tasks where spare_id=spare;

  update app.items set deliverer_id=hh where id=body;
  if not exists(select 1 from app.v_spare_shipping_tasks where id=task and recipient_staff_id=hh)
    or not exists(select 1 from app.items where id=accessory and deliverer_id=hh)
  then raise exception 'Main assignment did not update the shipping destination and linked accessory';end if;
  if (select owner_staff_id from app.spare_shipping_tasks where id=task)<>before_owner
    or (select count(*) from app.spare_shipping_tasks where spare_id=spare)<>1
  then raise exception 'Source holder or unique task identity was changed';end if;

  -- Editing the linked accessory follows the existing parent-redirection rule.
  update app.items set deliverer_id=dd where id=accessory;
  if not exists(select 1 from app.v_spare_shipping_tasks where id=task and recipient_staff_id=dd)
  then raise exception 'Accessory edit did not update the shipping destination';end if;

  -- Same holder / missing assignee must not create impossible shipping requests.
  update app.items set deliverer_id=aa where id=body;
  if exists(select 1 from app.v_spare_shipping_tasks where id=task)
    or not exists(select 1 from app.spare_shipping_tasks where id=task and not delivery_required)
  then raise exception 'Same-holder request was not suspended';end if;
  update app.items set deliverer_id=null where id=body;
  if exists(select 1 from app.v_spare_shipping_tasks where id=task)
  then raise exception 'Unassigned request remained visible';end if;
  update app.items set deliverer_id=hh where id=body;
  if not exists(select 1 from app.v_spare_shipping_tasks where id=task and recipient_staff_id=hh)
  then raise exception 'Existing request did not resume with the new assignee';end if;

  -- The current admin may send; later assignment changes must preserve history.
  perform app.send_spare_shipping(task,'recipient-regression-tracking');
  select sent_at into strict old_sent from app.spare_shipping_tasks where id=task;
  update app.items set deliverer_id=dd where id=body;
  if not exists(select 1 from app.spare_shipping_tasks where id=task and recipient_staff_id=hh
                and sent_at=old_sent and tracking_no='recipient-regression-tracking')
  then raise exception 'Sent shipping history was rewritten';end if;
  perform app.complete_spare_shipping(task);
  update app.items set deliverer_id=aa where id=body;
  if not exists(select 1 from app.spare_shipping_tasks where id=task and recipient_staff_id=hh and completed_at is not null)
  then raise exception 'Completed shipping history was rewritten';end if;
  -- A displayed holder-name edit must update the ID used for shipping as well.
  insert into app.spare_accessories(owner_staff_id,owner_name,title,cost_amount,purchased_at,marketplace,marketplace_item_id)
  values(aa,'長部 一輝','holder regression remote',500,'2026-10-01','ヤフオク','holder-regression-spare') returning id into spare;
  result:=app.register_item_with_spare(jsonb_build_object('lot_seq',899996,'purchaser_id',aa,'deliverer_id',dd,
    'purchased_at','2026-10-17','title','holder regression body','cost_amount',5000,'marketplace','ヤフオク',
    'sales_channel','FBA','work_stream','ブルーレイ'),spare);
  body:=(result->>'id')::uuid;
  select id into strict second_task from app.spare_shipping_tasks where spare_id=spare;
  update app.spare_accessories set owner_name='久保田 真由' where id=spare;
  if not exists(select 1 from app.spare_accessories where id=spare and owner_staff_id=ii)
    or not exists(select 1 from app.v_spare_shipping_tasks where id=second_task and owner_staff_id=ii and recipient_staff_id=dd)
  then raise exception 'Holder name edit left a stale holder ID or shipping source';end if;
  update app.items set deliverer_id=ii where id=body;
  if exists(select 1 from app.v_spare_shipping_tasks where id=second_task)
    or not exists(select 1 from app.spare_shipping_tasks where id=second_task and owner_staff_id=recipient_staff_id and not delivery_required)
  then raise exception 'Same physical holder still received a shipping request';end if;
  update app.spare_accessories set owner_staff_id=aa where id=spare;
  if not exists(select 1 from app.v_spare_shipping_tasks where id=second_task and owner_staff_id=aa and recipient_staff_id=ii)
  then raise exception 'Holder reassignment did not resume pending shipping';end if;
  update app.spare_accessories set owner_staff_id=null where id=spare;
  update app.items set deliverer_id=hh where id=body;
  if exists(select 1 from app.v_spare_shipping_tasks where id=second_task)
  then raise exception 'Unknown physical holder reactivated a shipping request';end if;
  if has_function_privilege('authenticated','app.sync_spare_shipping_recipient()','execute')
    or has_table_privilege('anon','app.spare_shipping_tasks','select')
  then raise exception 'Internal sync expanded direct/public access';end if;
end $test$;
rollback;
