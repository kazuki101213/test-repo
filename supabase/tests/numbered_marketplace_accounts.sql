begin;
set local role authenticated;
set local request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';

insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,
  sales_channel,sales_account_id,purchase_account_id,tracking_no,inspected_at)
select lot,(select id from app.staff where code='AA'),(select id from app.staff where code='DD'),
  current_date,'marketplace account regression',1000,'ヤフオク',channel::app.sales_channel,account,'auctions-2','123',now()
from (values (993111,'メルカリ','mercari-1'),(993112,'メルカリ','mercari-2'),
  (993113,'ヤフオク','auctions-1'),(993114,'ヤフオク','auctions-2')) fixture(lot,channel,account);

set local role postgres;
insert into app.item_photos(item_id,storage_path)
select id,'test/account-'||lot_seq||'.jpg' from app.items where lot_seq between 993111 and 993114;
insert into app.photo_reviews(item_id,drive_folder_id,exported_photo_count)
select id,'fixture-folder-'||lot_seq,1 from app.items where lot_seq between 993111 and 993114;

set local role authenticated;
select app.approve_photo_review(id) from app.items where lot_seq between 993111 and 993114;

do $$
declare i app.items; op uuid; scope text; expected text; result jsonb;
begin
  for i in select * from app.items where lot_seq between 993111 and 993114 order by lot_seq loop
    expected:=app.marketplace_account_label(i.sales_account_id);
    if app.seller_operation_context(i.id)->>'listing_account_id' is distinct from i.sales_account_id then
      raise exception 'Wrong confirmation account for %',expected;
    end if;
    foreach scope in array array['management','delivery'] loop
      result:=app.read_inventory_page(scope,jsonb_build_object('query',i.lot_seq,'states',
        jsonb_build_object('sales_channel',jsonb_build_array(expected),'marketplace',jsonb_build_array('ヤフオク2'))),10);
      if (result->>'total')::int<>1 or result->'rows'->0->>'sales_account_label' is distinct from expected then
        raise exception 'Numbered account is missing from % for %',scope,expected;
      end if;
      result:=app.read_inventory_page(scope,jsonb_build_object('query',i.lot_seq,'states',
        jsonb_build_object('sales_channel',jsonb_build_array(i.sales_channel||case when right(expected,1)='1' then '2' else '1' end))),10);
      if (result->>'total')::int<>0 then raise exception 'Other account leaked into % for %',scope,expected; end if;
    end loop;
    op:=app.queue_seller_operation(i.id,'listing',jsonb_build_object('expected_revision',i.updated_at,
      'title','test','description','description','price',1000,'condition','目立った傷や汚れなし',
      'origin','千葉県','shippingMethod','test','photos',jsonb_build_array('https://drive.google.com/test')),gen_random_uuid());
    if (select account_id from app.seller_operations where id=op) is distinct from i.sales_account_id then
      raise exception 'Wrong queued listing account for %',expected;
    end if;
  end loop;
  update app.items set sales_channel='FBA1' where lot_seq=993111;
  if exists (select 1 from app.items where lot_seq=993111 and sales_account_id is not null) then
    raise exception 'Changing the platform kept an incompatible account';
  end if;
end $$;
rollback;
