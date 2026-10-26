begin;
insert into app.items(sku,lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel)
select '998821-AADD-20261001-1234',998821,(select id from app.staff where code='AA'),(select id from app.staff where code='DD'),'2026-10-01','Original cost fixture',12345,'メルカリ','メルカリ';
insert into app.items(sku,lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel)
select '998821b-AAII-20261001-0',998821,(select id from app.staff where code='AA'),(select id from app.staff where code='II'),'2026-10-01','Return cost fixture',0,'動作品Amazon返品','メルカリ';
do $$begin
 if not exists(select 1 from app.items where sku='998821b-AAII-20261001-1234' and cost_amount=0) then raise exception 'Return SKU did not inherit original cost';end if;
 if app.return_sku_original_cost('998821aa-AAII-20261001-0',998821)<>'998821aa-AAII-20261001-1234' then raise exception 'Repeated a suffix unsupported';end if;
 if app.return_sku_original_cost('998822b-AAII-20261001-77',998822)<>'998822b-AAII-20261001-77' then raise exception 'Missing original was guessed';end if;
 if app.return_sku_original_cost('998821z-AAII-20261001-77',998821)<>'998821z-AAII-20261001-77' then raise exception 'Unrelated serial changed';end if;
end$$;
update app.items set purchased_at='2026-10-02' where sku='998821b-AAII-20261001-1234';
do $$begin
 if not exists(select 1 from app.items where sku='998821b-AAII-20261002-1234' and cost_amount=0) then raise exception 'Identity edit lost original cost';end if;
 if not exists(select 1 from app.item_sku_aliases where sku='998821b-AAII-20261001-1234') then raise exception 'Old SKU lookup lost';end if;
end$$;
rollback;
