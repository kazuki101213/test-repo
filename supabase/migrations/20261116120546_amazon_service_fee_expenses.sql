-- Called only by the authenticated amazon-payments Edge Function after refreshing a page.
grant select (id, incurred_on, category, name, amount, deleted_at),
  insert (incurred_on, category, name, amount, card_id, memo) on app.expenses to service_role;
grant select (id, name, is_active, expense_only) on app.payment_cards to service_role;

create function app.apply_amazon_service_fee_expenses(
  p_account text, p_marketplace text, p_transactions text[], p_account_label text
) returns jsonb
language plpgsql security invoker
set search_path = ''
as $$
declare
  fee app.amazon_payment_transactions%rowtype;
  expense_category app.expenses.category%type;
  expense_date date;
  expense_amount bigint;
  expense_name text;
  candidate_names text[];
  fee_kind text;
  method_id uuid;
  expense_id uuid;
  existing_ids uuid[];
  created integer := 0;
  matched integer := 0;
  linked integer := 0;
  zero integer := 0;
  review integer := 0;
begin
  if p_account !~ '^[0-9a-f]{64}$' or p_marketplace is distinct from 'A1VC38T7YXB528'
    or p_account_label is null or p_account_label not in ('Amazon1', 'Amazon2')
    or coalesce(cardinality(p_transactions), 0) not between 1 and 500 then
    raise exception 'Invalid Amazon service fee batch';
  end if;

  select id into strict method_id
    from app.payment_cards where name = 'Amazon売上金' and is_active and expense_only;
  -- Serialize matching and creation across Amazon accounts and simultaneous retries.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('app.apply_amazon_service_fee_expenses', 0));

  for fee in
    select t.* from app.amazon_payment_transactions t
    where t.account_key = p_account and t.marketplace_id = p_marketplace
      and t.transaction_id = any(p_transactions)
      and t.transaction_type = 'ServiceFee'
      and t.status in ('RELEASED', 'DEFERRED_RELEASED')
    order by t.posted_at, t.transaction_id
  loop
    if exists (select 1 from app.amazon_fee_expense_links l where l.account_key = p_account
       and l.marketplace_id = p_marketplace and l.transaction_id = fee.transaction_id) then
      linked := linked + 1;
      continue;
    end if;

    if fee.currency is distinct from 'JPY' or fee.amount is null
      or trunc(fee.amount) <> fee.amount or abs(fee.amount) > 9007199254740991 then
      review := review + 1;
      continue;
    end if;

    if fee.amount = 0 then
      insert into app.amazon_fee_expense_links(account_key, marketplace_id, transaction_id, resolution)
      values (p_account, p_marketplace, fee.transaction_id, 'zero');
      zero := zero + 1;
      continue;
    end if;

    expense_date := (fee.posted_at at time zone 'Asia/Tokyo')::date;
    expense_amount := -fee.amount;
    fee_kind := pg_catalog.lower(pg_catalog.regexp_replace(coalesce(fee.description, ''), '[^a-zA-Z]', '', 'g'));
    case
      when fee_kind in ('subscription', 'subscriptionfee') then
        expense_category := '固定費';
        expense_name := 'Amazon大口';
        candidate_names := array[expense_name, 'Amazon大口(1アカ目)', 'Amazon大口(2アカ目)', 'Amazon月額利用料', 'Amazon 月額利用料'];
      when fee_kind in ('fbapostinboundtransportation', 'inboundtransportationfee', 'fbainboundtransportationfee') then
        expense_category := '配送費';
        expense_name := 'Amazon 納品時の輸送手数料';
        candidate_names := array[expense_name, 'Amazon FBAパートナーキャリアの配送料', 'Amazon FBAパートナーキャリアの配送料:', 'FBA納品送料'];
      when fee_kind in ('fbainventorystoragefee', 'fbastoragefee', 'storagefee', 'longtermstoragefee', 'agedinventorysurcharge') then
        expense_category := '保管料';
        expense_name := 'Amazon FBA保管手数料';
        candidate_names := array[expense_name, 'Amazon FBA保管手数料：', 'Amazon FBA在庫保管手数料'];
      when fee_kind in ('fbainventoryreturnfee', 'fbainventoryremovalfee', 'fbaremovalfee', 'returnfee', 'removalfee') then
        expense_category := '配送費';
        expense_name := 'Amazon FBA在庫の返送手数料';
        candidate_names := array[expense_name, expense_name || ':'];
      when fee_kind in ('fbainventorydisposalfee', 'fbadisposalfee', 'disposalfee') then
        expense_category := '支払手数料';
        expense_name := 'Amazon FBA在庫の廃棄手数料';
        candidate_names := array[expense_name];
      else
        expense_category := '支払手数料';
        expense_name := 'Amazon サービス料金';
        candidate_names := array[expense_name];
    end case;

    -- A real expense may already have been recorded by a person or the older CSV import.
    select array_agg(e.id order by e.id) into existing_ids
    from app.expenses e
    where e.incurred_on = expense_date and e.category = expense_category and e.amount = expense_amount
      and e.name = any(candidate_names) and e.deleted_at is null
      and not exists (
        select 1 from app.amazon_fee_expense_links l
        join app.amazon_payment_transactions t using (account_key, marketplace_id, transaction_id)
        where l.expense_id = e.id and t.transaction_type = 'ServiceFee'
      );

    if cardinality(existing_ids) > 1 or exists (
      select 1 from app.amazon_fee_expense_links l where l.expense_id = any(existing_ids)
    ) then
      review := review + 1;
      continue;
    end if;

    if cardinality(existing_ids) = 1 then
      insert into app.amazon_fee_expense_links(account_key, marketplace_id, transaction_id, expense_id, resolution)
      values (p_account, p_marketplace, fee.transaction_id, existing_ids[1], 'matched_existing');
      matched := matched + 1;
    else
      insert into app.expenses(incurred_on, category, name, amount, card_id, memo)
      values (expense_date, expense_category, expense_name, expense_amount, method_id,
        pg_catalog.concat_ws(' / ', p_account_label, nullif(fee.description, ''), '取引ID ' || fee.transaction_id))
      returning id into expense_id;
      insert into app.amazon_fee_expense_links(account_key, marketplace_id, transaction_id, expense_id, resolution)
      values (p_account, p_marketplace, fee.transaction_id, expense_id, 'created');
      created := created + 1;
    end if;
  end loop;

  return jsonb_build_object('created', created, 'matched', matched, 'linked', linked, 'zero', zero, 'review', review);
end
$$;

revoke all on function app.apply_amazon_service_fee_expenses(text, text, text[], text) from public, anon, authenticated;
grant execute on function app.apply_amazon_service_fee_expenses(text, text, text[], text) to service_role;
notify pgrst, 'reload schema';
