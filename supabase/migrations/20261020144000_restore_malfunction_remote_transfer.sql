-- Restore the registered-remote transfer for the eight explicit Yahoo photo templates.
create or replace function app.apply_malfunction_reply() returns trigger
language plpgsql security definer set search_path=pg_catalog,app as $$
declare previous_channel app.sales_channel;
begin
 if auth.uid() is null or new.author_id is distinct from app.current_staff_id() then return new;end if;
 if not exists(select 1 from app.items i join app.staff s on s.id=new.author_id where i.id=new.item_id and i.status='動作不良' and i.sold_on is null and (s.role='admin' or (s.role='purchaser' and i.purchaser_id=s.id))) then return new;end if;
 select sales_channel into previous_channel from app.items where id=new.item_id for update;
 if new.task_kind='仕入先確認' then
  update app.items set supplier_contact_requested_at=coalesce(supplier_contact_requested_at,new.created_at) where id=new.item_id;
 elsif new.task_kind like '%ヤフオク%' then
  -- Only registered remotes are moved. Other templates keep all accessories.
  if new.task_kind in ('Panasonic◯ヤフオク','Panasonic×ヤフオク','SONY◯ヤフオク','SONY×ヤフオク',
                       'SHARP◯ヤフオク','SHARP×ヤフオク','TOSHIBA◯ヤフオク','TOSHIBA×ヤフオク')
   and exists(select 1 from app.items body join app.items remote
     on app.product_serial(remote.sku,remote.lot_seq)=app.product_serial(body.sku,body.lot_seq)
     where body.id=new.item_id and not body.is_accessory and remote.is_accessory and remote.title ilike '%リモコン%') then
   -- Transfer before the body update can synchronize the accessory SKU.
   perform app.prepare_yahoo_auction_item(new.item_id);
  end if;
  update app.items set
   workflow_previous_sales_channel=previous_channel,workflow_decision='yahoo',sales_channel='ヤフオク',
   condition=case when new.task_kind in ('Panasonic×ヤフオク','SONY×ヤフオク','SHARP×ヤフオク','TOSHIBA×ヤフオク') then '可'::app.item_condition else condition end,
   malfunction_resolved_at=clock_timestamp(),malfunction_resolved_by=new.author_id,status='商品登録前'
  where id=new.item_id;
 end if;
 return new;
end $$;
revoke all on function app.apply_malfunction_reply() from public,anon,authenticated;
