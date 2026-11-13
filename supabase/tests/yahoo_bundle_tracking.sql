begin;

select set_config('request.jwt.claim.sub', (
  select p.user_id::text from app.profiles p join app.staff s on s.id = p.staff_id where s.code = 'AA' limit 1
), true);

insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel,marketplace_item_id,memo)
select fixture.lot, buyer.id, deliverer.id, (now() at time zone 'Asia/Tokyo')::date,
  'tracking fixture', 1000, 'ヤフオク', 'ヤフオク', fixture.auction, fixture.memo
from (values
  (998851,'j9988500001','998851、998852同梱。'),
  (998852,'j9988500001','998851、998852同梱。'),
  (998853,'j9988500002','998853、998854同梱。'),
  (998854,'j9988500002',null)
) as fixture(lot,auction,memo)
cross join app.staff buyer
cross join app.staff deliverer
where buyer.code='AA' and deliverer.code='DD';

set local role authenticated;
do $test$
declare
  result jsonb;
begin
  result := app.reconcile_marketplace_tracking('ヤフオク','ヤフオク1','j9988500002','123456789012');
  if result->>'status' is distinct from '在庫ID重複' then raise exception 'Unconfirmed bundle was accepted: %', result; end if;
  result := app.reconcile_marketplace_tracking('ヤフオク','ヤフオク1','j9988500001','123456789012');
  if result->>'updated_count' is distinct from '2' then raise exception 'Both bundle items were not updated: %', result; end if;
  result := app.reconcile_marketplace_tracking('ヤフオク','ヤフオク1','j9988500001','123456789012');
  if result->>'result' is distinct from 'already_matched' then raise exception 'Repeat was not idempotent: %', result; end if;
  result := app.reconcile_marketplace_tracking('ヤフオク','ヤフオク1','j9988500001','999999999999');
  if result->>'status' is distinct from '在庫ID重複' then raise exception 'Conflicting tracking number was accepted: %', result; end if;
  if (select count(*) from app.items where marketplace_item_id='j9988500001' and tracking_no='123456789012') <> 2
    or exists (select 1 from app.items where marketplace_item_id='j9988500002' and tracking_no is not null) then
    raise exception 'Tracking values changed unexpectedly';
  end if;
end;
$test$;

rollback;
