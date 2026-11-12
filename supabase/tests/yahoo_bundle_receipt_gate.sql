begin;
select set_config('request.jwt.claim.sub',(select p.user_id from app.profiles p join app.staff s on s.id=p.staff_id where s.role='admin' and s.is_active limit 1)::text,true);
select set_config('request.jwt.claims',jsonb_build_object('sub',current_setting('request.jwt.claim.sub'),'role','authenticated')::text,true);

insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel,marketplace_item_id,tracking_no,memo,inspected_at,cleaned_at)
select lot,(select id from app.staff where code='AA'),(select id from app.staff where code='DD'),current_date,'bundled receipt fixture',100,market::app.marketplace,'メルカリ','receipt-bundle-'||lot,tracking,memo,
 case when ready then now() end,case when ready then now() end
from (values
 (991011,'ヤフオク','8274-1356-8012',E'着払いです。\n991011、991012同梱。',true),
 (991012,'ヤフオク',null,null,false),
 (991013,'ヤフオク','8274-1356-8013',null,true),
 (991014,'メルカリ','8274-1356-8013',null,false)
) fixture(lot,market,tracking,memo,ready);

insert into app.receipt_evaluation_tasks(item_id,requested_at)
select id,now() from app.items where lot_seq between 991011 and 991014;

set local role authenticated;
do $test$
declare
 v_item uuid;
 v_context jsonb;
 v_token uuid;
 v_reservation jsonb;
begin
 select id into strict v_item from app.items where lot_seq=991011;
 v_context=app.marketplace_receipt_context('ヤフオク','receipt-bundle-991011');
 if v_context->>'receipt_bundle_waiting' is distinct from 'true'
   or v_context->'items'->0->>'receipt_ready' is distinct from 'false'
   or v_context->'items'->0->>'inspected_at' is not null
   or v_context->'items'->0->>'cleaned_at' is not null
   or (app.marketplace_extension_probe('ヤフオク','receipt-bundle-991011')->'items'->0->>'inspected_at') is null then
  raise exception 'Bundle memo did not block a ready unit before the second tracking number was entered';
 end if;
 if app.marketplace_receipt_context('ヤフオク','receipt-bundle-991012')->>'receipt_bundle_waiting' is not null then
  raise exception 'A fully inspected sibling caused an additional hold';
 end if;
 if exists(select 1 from app.v_receipt_evaluation_tasks where item_id=v_item) then
  raise exception 'Admin list offered an incomplete bundle';
 end if;
 begin
  perform app.complete_receipt_evaluation_task(v_item);
  raise exception 'Admin task completion ignored the bundle hold';
 exception when invalid_parameter_value then null;
 end;
 if (app.marketplace_extension_receipt('reserve','ヤフオク','receipt-bundle-991011','fixture-account')->>'eligible')::boolean is not false then
  raise exception 'Extension reserved an incomplete bundle';
 end if;
 if not exists(select 1 from app.v_receipt_evaluation_tasks where lot_seq=991013) then
  raise exception 'Another marketplace with the same tracking number blocked a standalone transaction';
 end if;

 update app.items set tracking_no='8274 1356 8012' where lot_seq=991012;
 update app.items set memo=null where id=v_item;
 if app.marketplace_receipt_context('ヤフオク','receipt-bundle-991011')->>'receipt_bundle_waiting' is distinct from 'true' then
  raise exception 'Matching tracking numbers did not block the second lot';
 end if;

 update app.items set inspected_at=now() where lot_seq=991012;
 if (select count(*) from app.v_receipt_evaluation_tasks where lot_seq in (991011,991012))<>2 then
  raise exception 'Ready bundle did not reappear';
 end if;
 v_reservation=app.marketplace_extension_receipt('reserve','ヤフオク','receipt-bundle-991011','fixture-account');
 if (v_reservation->>'eligible')::boolean is not true then
  raise exception 'Fully inspected bundle was not eligible';
 end if;
 v_token=(v_reservation->>'token')::uuid;
 update app.items set inspected_at=null,memo='991011、991012同梱。',tracking_no=null where lot_seq=991012;
 if app.marketplace_receipt_context('ヤフオク','receipt-bundle-991011')->>'receipt_bundle_waiting' is distinct from 'true' then
  raise exception 'A memo on the sibling did not block a cancelled bundle';
 end if;
 begin
  perform app.marketplace_extension_receipt('begin','ヤフオク','receipt-bundle-991011','fixture-account',v_token);
  raise exception 'Extension began submitting after sibling inspection was cancelled';
 exception when raise_exception then
  if sqlerrm<>'評価条件が変わりました' then raise; end if;
 end;
 perform app.marketplace_extension_receipt('release','ヤフオク','receipt-bundle-991011','fixture-account',v_token);
end $test$;
reset role;
rollback;
select 'passed: bundled receipt hold and recheck, separate purchase unchanged' as result;
