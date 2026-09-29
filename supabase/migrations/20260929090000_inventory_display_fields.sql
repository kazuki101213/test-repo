-- Keep the two refund sources visible without changing the existing profit formula.
alter table app.items
  add column if not exists amazon_refund_amount bigint not null default 0 check (amazon_refund_amount >= 0),
  add column if not exists non_amazon_refund_amount bigint not null default 0 check (non_amazon_refund_amount >= 0);

update app.items
set amazon_refund_amount = case when refund_note ilike '%Amazon%' then refund_amount else 0 end,
    non_amazon_refund_amount = case when refund_note ilike '%Amazon%' then 0 else refund_amount end
where refund_amount > 0
  and amazon_refund_amount = 0 and non_amazon_refund_amount = 0;

create or replace function app.sync_refund_sources() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if new.refund_amount > 0 and new.amazon_refund_amount = 0 and new.non_amazon_refund_amount = 0 then
      if new.refund_note ilike '%Amazon%' then new.amazon_refund_amount := new.refund_amount;
      else new.non_amazon_refund_amount := new.refund_amount; end if;
    else
      new.refund_amount := new.amazon_refund_amount + new.non_amazon_refund_amount;
    end if;
  elsif new.amazon_refund_amount is distinct from old.amazon_refund_amount
     or new.non_amazon_refund_amount is distinct from old.non_amazon_refund_amount then
    new.refund_amount := new.amazon_refund_amount + new.non_amazon_refund_amount;
  elsif new.refund_amount is distinct from old.refund_amount then
    if new.refund_note ilike '%Amazon%' then
      new.amazon_refund_amount := new.refund_amount;
      new.non_amazon_refund_amount := 0;
    else
      new.amazon_refund_amount := 0;
      new.non_amazon_refund_amount := new.refund_amount;
    end if;
  end if;
  return new;
end; $$;
revoke all on function app.sync_refund_sources() from public, anon, authenticated;
drop trigger if exists items_sync_refund_sources on app.items;
create trigger items_sync_refund_sources before insert or update of refund_amount, amazon_refund_amount, non_amazon_refund_amount
on app.items for each row execute function app.sync_refund_sources();

create or replace view app.v_inventory_display with (security_invoker = true) as
select inventory.*,
  raw.product_id, product.product_no, product.image_url as amazon_image_url,
  raw.amazon_refund_amount, raw.non_amazon_refund_amount,
  latest.body as latest_comment
from app.v_inventory_items inventory
join app.items raw on raw.id = inventory.id
left join app.products product on product.id = raw.product_id
left join lateral (
  select body from app.item_comments
  where item_id = inventory.id
  order by created_at desc, id desc limit 1
) latest on true;
grant select on app.v_inventory_display to authenticated;
