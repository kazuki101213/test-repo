alter table app.items drop constraint if exists items_refund_amount_check;
alter table app.items drop constraint if exists items_amazon_refund_amount_check;
alter table app.amazon_refund_matches drop constraint if exists amazon_refund_matches_amount_check;
alter table app.amazon_refund_matches
  add constraint amazon_refund_matches_amount_check
  check ((refund_kind = 'inventory' and amount >= 0) or refund_kind = 'amazon_refund');

create or replace function app.sync_refund_sources() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if new.refund_amount <> 0 and new.amazon_refund_amount = 0 and new.non_amazon_refund_amount = 0 then
      if new.refund_note ilike '%Amazon%' then
        new.amazon_refund_amount := new.refund_amount;
      elsif new.refund_amount < 0 then
        raise exception 'Negative refund amounts must be recorded as Amazon refunds';
      else
        new.non_amazon_refund_amount := new.refund_amount;
      end if;
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
    elsif new.refund_amount < 0 then
      raise exception 'Negative refund amounts must be recorded as Amazon refunds';
    else
      new.amazon_refund_amount := 0;
      new.non_amazon_refund_amount := new.refund_amount;
    end if;
  end if;
  return new;
end; $$;

create or replace function app.apply_amazon_refund(p_account text,p_transaction text,p_sku text,p_actor uuid)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare
 txn app.amazon_payment_transactions%rowtype;
 kind text;
 amount_value bigint;
 target app.items%rowtype;
 prior app.amazon_refund_matches%rowtype;
 delta bigint;
 root_serial text;
 matching_refunds integer;
begin
 if not exists(select 1 from app.profiles p join app.staff s on s.id=p.staff_id where p.user_id=p_actor and s.role='admin' and s.is_active) then raise exception 'Administrator required'; end if;
 select * into txn from app.amazon_payment_transactions where account_key=p_account and marketplace_id='A1VC38T7YXB528' and transaction_id=p_transaction;
 if not found or txn.status not in ('RELEASED','支払い実行済み') then return jsonb_build_object('status','review','reason','支払い実行済みのAmazon取引が見つかりません。'); end if;
 kind:=case when lower(coalesce(txn.transaction_type,'')) in ('inventory reimbursement','inventoryreimbursement','fba inventory reimbursement','fbainventoryreimbursement','fba_inventory_reimbursement','在庫の払い戻し','在庫払い戻し') then 'inventory'
            when lower(coalesce(txn.transaction_type,'')) in ('refund','返金') then 'amazon_refund' else null end;
 if kind is null then return jsonb_build_object('status','review','reason','対象外の取引種類です。'); end if;
 if (select count(*) from jsonb_array_elements(txn.item_breakdowns) e where e->>'sku'=p_sku)<>1 then return jsonb_build_object('status','review','reason','SKUを取引内で一意に特定できません。'); end if;
 select case when kind='inventory' then abs((e->>'amount')::numeric)::bigint else (e->>'amount')::numeric::bigint end into amount_value
 from jsonb_array_elements(txn.item_breakdowns) e where e->>'sku'=p_sku and e->>'currency'='JPY' and e->>'amount' ~ '^-?[0-9]+(\.0+)?$';
 if amount_value is null then return jsonb_build_object('status','review','reason','SKU別の返金額が円の整数として確認できません。'); end if;
 if kind='inventory' and amount_value<0 then return jsonb_build_object('status','review','reason','在庫の払い戻し金額が負数のため確認が必要です。'); end if;
 root_serial:=(regexp_match(p_sku,'^([0-9]+)'))[1];
 if root_serial is null then return jsonb_build_object('status','review','reason','Amazon SKUから通番号を読み取れません。'); end if;
 select count(*) into matching_refunds
 from app.amazon_payment_transactions t
 where t.account_key=p_account and t.marketplace_id=txn.marketplace_id
   and lower(coalesce(t.transaction_type,'')) in ('refund','返金')
   and t.status in ('RELEASED','支払い実行済み')
   and (t.posted_at,t.transaction_id)<=(txn.posted_at,txn.transaction_id)
   and exists (select 1 from jsonb_array_elements(t.item_breakdowns) e where e->>'sku'=p_sku and e->>'currency'='JPY' and e->>'amount' ~ '^-?[0-9]+(\.0+)?$');
 if matching_refunds>1 then
   select * into target from app.items i where not i.is_accessory and (regexp_match(i.sku,'^([0-9]+)'))[1]=root_serial
   order by length(coalesce((regexp_match(app.product_serial(i.sku,i.lot_seq),'^[0-9]+([a-z]*)$'))[1],'')),app.product_serial(i.sku,i.lot_seq),i.sku
   offset matching_refunds-1 limit 1;
   if not found then return jsonb_build_object('status','review','reason','同じSKUの返品回数に対応する本体行がありません。SKU順の在庫を確認してください。'); end if;
 else
   select * into target from app.items where lower(sku)=lower(p_sku) and not is_accessory;
   if not found then
     select count(*) into matching_refunds from app.items i where not i.is_accessory and (regexp_match(i.sku,'^([0-9]+)'))[1]=root_serial;
     if matching_refunds<>1 then return jsonb_build_object('status','review','reason','対応する在庫行を一意に特定できません。'); end if;
     select * into target from app.items i where not i.is_accessory and (regexp_match(i.sku,'^([0-9]+)'))[1]=root_serial;
   end if;
 end if;
 select * into prior from app.amazon_refund_matches where account_key=p_account and marketplace_id=txn.marketplace_id and transaction_id=p_transaction and sku=p_sku;
 if prior.amount is not null and prior.item_id<>target.id then return jsonb_build_object('status','review','reason','以前の反映先と今回のSKU順割当が異なるため、自動で移し替えません。管理者の確認が必要です。'); end if;
 delta:=amount_value-coalesce(prior.amount,0);
 if delta<>0 then
   if kind='inventory' then update app.items set inventory_refund_amount=greatest(inventory_refund_amount+delta,0) where id=target.id;
   else update app.items set amazon_refund_amount=amazon_refund_amount+delta where id=target.id;
   end if;
 end if;
 insert into app.amazon_refund_matches(account_key,marketplace_id,transaction_id,sku,item_id,refund_kind,amount,applied_by)
 values(p_account,txn.marketplace_id,p_transaction,p_sku,target.id,kind,amount_value,p_actor)
 on conflict(account_key,marketplace_id,transaction_id,sku) do update set item_id=excluded.item_id,refund_kind=excluded.refund_kind,amount=excluded.amount,applied_by=excluded.applied_by,applied_at=now();
 return jsonb_build_object('status',case when prior.amount is null then 'applied' when delta=0 then 'unchanged' else 'applied' end,'reason',case when kind='inventory' then '在庫の払い戻しを反映しました。' else 'Amazon返金金額を反映しました。' end,'amount',amount_value,'sku',p_sku,'item_id',target.id);
end $$;

revoke all on function app.apply_amazon_refund(text,text,text,uuid) from public,anon,authenticated;
grant execute on function app.apply_amazon_refund(text,text,text,uuid) to service_role;
notify pgrst,'reload schema';
