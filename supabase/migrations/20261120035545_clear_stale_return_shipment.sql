-- Amazon返品の個体は、返品前のFBA出荷日（shipped_on <= amazon_returned_on）を残す設計。
-- メルカリ・ヤフオクの発送処理（LINE発送依頼の作成・発送コード日付の記録・発送依頼の補完）は
-- 「shipped_on is null」で未発送を判定するため、返品個体が売れても発送依頼が作られなかった（1156b, 2026-11-20）。
-- フリマで取引中になった時点で、返品前の古い出荷日だけを空にする。返品後に出荷し直した日付（返品日より後）は触らない。
create or replace function app.clear_stale_return_shipment()
returns trigger language plpgsql set search_path = pg_catalog, app as $$
begin
  if new.status = '取引中' and new.sold_on is null
     and app.sales_channel_family(new.sales_channel) in ('メルカリ', 'ヤフオク')
     and new.amazon_returned_on is not null
     and new.shipped_on is not null and new.shipped_on <= new.amazon_returned_on then
    new.shipped_on := null;
  end if;
  return new;
end $$;
revoke all on function app.clear_stale_return_shipment() from public, anon, authenticated;

drop trigger if exists items_clear_stale_return_shipment on app.items;
create trigger items_clear_stale_return_shipment
before insert or update of status, sales_channel, shipped_on on app.items
for each row execute function app.clear_stale_return_shipment();

-- 既存の該当行（2026-11-20時点では1156bのみ。手動で空にし済み）を同じ規則で揃える。
update app.items set shipped_on = null
where status = '取引中' and sold_on is null
  and app.sales_channel_family(sales_channel) in ('メルカリ', 'ヤフオク')
  and amazon_returned_on is not null and shipped_on is not null and shipped_on <= amazon_returned_on;
