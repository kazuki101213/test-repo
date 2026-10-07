begin;
select set_config('request.jwt.claims',json_build_object('sub',(select p.user_id from app.profiles p join app.staff s on s.id=p.staff_id where s.role='admin' and s.is_active order by p.user_id limit 1),'role','authenticated')::text,true);
set local role authenticated;
do $$
declare r jsonb; d text := ((now() at time zone 'Asia/Tokyo')::date)::text; test_id text := 'm99999990000000000002';
begin
r:=app.marketplace_purchase_import('メルカリ','自動取得テスト',jsonb_build_array(jsonb_build_object('marketplace_item_id',test_id,'marketplace_url','https://jp.mercari.com/item/'||test_id,'title','価格未確認テスト','purchased_at',d)));
if (r->>'inserted')::int<>1 then raise exception 'initial draft failed'; end if;
if app.marketplace_purchase_context('メルカリ')->'knownIds' @> jsonb_build_array(test_id) then raise exception 'missing price excluded from refresh'; end if;
r:=app.marketplace_purchase_import('メルカリ','自動取得テスト',jsonb_build_array(jsonb_build_object('marketplace_item_id',test_id,'marketplace_url','https://jp.mercari.com/item/'||test_id,'title','確認済の商品名','cost_amount',1500,'purchased_at',d)));
if (r->>'inserted')::int<>0 or (r->>'refreshed')::int<>1 then raise exception 'duplicate or refresh failed'; end if;
if not exists(select 1 from app.marketplace_purchase_drafts where marketplace_item_id=test_id and cost_amount=1500 and title='確認済の商品名') then raise exception 'facts not refreshed'; end if;
if not (app.marketplace_purchase_context('メルカリ')->'knownIds' @> jsonb_build_array(test_id)) then raise exception 'known draft not excluded'; end if;
end $$;
select 'missing price refresh verified; rollback' as result;
rollback;