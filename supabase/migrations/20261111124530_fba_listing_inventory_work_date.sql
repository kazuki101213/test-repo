-- Record the date chosen at Amazon listing acceptance, while leaving FBA inbound status to its own workflow.
-- Only the listing service can write these receipts. Keep inventory writes scoped to this trigger.
create function app.record_fba_listing_inventory_work_date() returns trigger
language plpgsql security definer set search_path=pg_catalog,app as $$
begin
  update app.items i
     set packed_on=new.work_completed_on
   where i.id=new.item_id
     and i.packed_on is null
     and i.sales_channel=new.sales_channel
     and i.status in ('商品登録前','出品中','取引中','販売済')
     and (i.sku=new.sku or exists (
       select 1 from app.item_sku_aliases a where a.item_id=i.id and a.sku=new.sku
     ))
     and new.work_completed_on between i.purchased_at and (new.created_at at time zone 'Asia/Tokyo')::date;
  return new;
end;
$$;
revoke all on function app.record_fba_listing_inventory_work_date() from public,anon,authenticated;

create trigger amazon_listing_record_fba_work_date
after insert or update of state on app.amazon_listing_submissions
for each row when (new.sales_channel in ('FBA','FBA1','FBA2') and new.state in ('accepted','verified'))
execute function app.record_fba_listing_inventory_work_date();

-- Restore recorded work dates only where the current inventory row is blank.
with saved_dates as (
  select distinct on (i.id) i.id,s.work_completed_on
    from app.amazon_listing_submissions s
    join app.items i on i.id=s.item_id and i.sales_channel=s.sales_channel
   where s.sales_channel in ('FBA','FBA1','FBA2') and s.state in ('accepted','verified')
     and i.packed_on is null and i.status in ('商品登録前','出品中','取引中','販売済')
     and (i.sku=s.sku or exists (
       select 1 from app.item_sku_aliases a where a.item_id=i.id and a.sku=s.sku
     ))
     and s.work_completed_on between i.purchased_at and (s.created_at at time zone 'Asia/Tokyo')::date
   order by i.id,s.created_at desc,s.request_id desc
)
update app.items i
   set packed_on=s.work_completed_on
  from saved_dates s
 where i.id=s.id and i.packed_on is null;
