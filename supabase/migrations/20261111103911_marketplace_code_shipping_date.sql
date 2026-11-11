-- Code issuance is the dispatch date for marketplace trades. A LINE request
-- already queued for that code must still reach the person who will use it.
alter table app.delivery_line_outbox
  add column code_issue_operation_id uuid references app.seller_operations(id) on delete set null;

create or replace function app.line_shipping_eligible(p_id uuid)
returns boolean
language sql stable
set search_path = ''
as $$
  select coalesce((
    select not l.blocked and s.is_active and s.id = i.deliverer_id
      and o.state <> 'cancelled' and i.status = '取引中'
      and i.sold_on is null and i.seller_cancelled_at is null
      and (
        (t.resolved_at is null and i.shipped_on is null)
        or exists (
          select 1 from app.seller_operations issue
          join app.seller_listings listing on listing.item_id = i.id and listing.active
            and listing.channel = issue.channel and listing.account_id = issue.account_id
            and listing.trade_key = o.trade_key
          where issue.id = o.code_issue_operation_id and issue.item_id = i.id
            and issue.kind in ('shipping_code', 'register_package') and issue.status = 'succeeded'
            and issue.channel = i.sales_channel and issue.payload->>'trade_key' = i.seller_trade_key
            and issue.created_at >= t.created_at
            and (issue.finished_at at time zone 'Asia/Tokyo')::date = i.shipped_on
        )
      )
      and (
        app.sales_channel_family(i.sales_channel) = '自己発送'
        or (
          app.sales_channel_family(i.sales_channel) in ('メルカリ', 'ヤフオク')
          and o.trade_key = i.seller_trade_key
          and exists (
            select 1 from app.seller_listings sl where sl.item_id = i.id and sl.active
              and sl.trade_key = o.trade_key and sl.channel = i.sales_channel
          )
        )
      )
    from app.delivery_line_outbox o join app.delivery_line_links l on l.id = o.link_id
    join app.staff s on s.id = l.staff_id join app.delivery_shipping_tasks t on t.id = o.task_id
    join app.items i on i.id = t.item_id where o.id = p_id
  ), false);
$$;

create function app.record_marketplace_code_shipping_date()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  trade text := new.payload->>'trade_key';
  issued_on date := (new.finished_at at time zone 'Asia/Tokyo')::date;
begin
  if new.kind not in ('shipping_code', 'register_package') or new.status <> 'succeeded'
    or old.status = 'succeeded' or issued_on is null or nullif(trade, '') is null
    or app.sales_channel_family(new.channel) not in ('メルカリ', 'ヤフオク') then
    return new;
  end if;

  perform 1 from app.items i
  join app.seller_listings l on l.item_id = i.id and l.active
    and l.channel = new.channel and l.account_id = new.account_id and l.trade_key = trade
  where i.id = new.item_id and i.sales_channel = new.channel and i.seller_trade_key = trade
    and i.status = '取引中' and i.shipped_on is null and i.sold_on is null
    and i.seller_cancelled_at is null
    and exists (
      select 1 from app.delivery_shipping_tasks t
      where t.item_id = i.id and t.resolved_at is null and t.created_at <= new.created_at
    )
  for update of i;
  if not found then return new; end if;

  update app.delivery_line_outbox o set code_issue_operation_id = new.id
  from app.delivery_shipping_tasks t
  where o.task_id = t.id and t.item_id = new.item_id and t.resolved_at is null
    and t.created_at <= new.created_at and o.trade_key = trade
    and o.state in ('pending', 'sending', 'failed');

  update app.items set shipped_on = issued_on where id = new.item_id;
  return new;
end;
$$;
revoke all on function app.record_marketplace_code_shipping_date() from public, anon, authenticated;

create trigger seller_operations_record_code_shipping_date
after update of status on app.seller_operations
for each row when (old.status is distinct from new.status and new.status = 'succeeded')
execute function app.record_marketplace_code_shipping_date();
