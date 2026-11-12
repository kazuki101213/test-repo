-- Saving the next account during listing preparation must preserve the previous transaction.
do $migration$
declare
  definition text;
  updated text;
begin
  definition := pg_get_functiondef('app.keep_marketplace_account_consistent()'::regprocedure);
  updated := replace(definition,
    'if new.sales_account_id is not null and new.sales_account_id is distinct from old.sales_account_id then',
    'if new.sales_account_id is not null and new.sales_account_id is distinct from old.sales_account_id
          and (new.status is distinct from ''商品登録前'' or new.sold_on is not null) then');
  if updated = definition then raise exception 'Marketplace account trigger guard not found'; end if;
  execute updated;

  definition := pg_get_functiondef('app.inventory_marketplace_accounts(uuid)'::regprocedure);
  updated := replace(definition, 'coalesce(listing.account_id,history.account_id,',
    'coalesce(planned.account_id,listing.account_id,history.account_id,');
  if updated = definition then raise exception 'Marketplace account display not found'; end if;
  definition := updated;
  updated := replace(definition,
    '''flea_listing_account_label'',app.marketplace_account_label(other_listing.account_id))',
    '''flea_listing_account_label'',app.marketplace_account_label(coalesce(other_listing.account_id,
      case when planned.account_id is distinct from listing.account_id and planned.account_id is not null
        then listing.account_id end)))');
  if updated = definition then raise exception 'Marketplace listing display not found'; end if;
  definition := updated;
  updated := replace(definition, '  ) listing on true',
    '  ) listing on true
  cross join lateral (
    select case when coalesce(parent.status,i.status)=''商品登録前'' and coalesce(parent.sold_on,i.sold_on) is null
      then case when parent.id is null then i.sales_account_id else parent.sales_account_id end end as account_id
  ) planned');
  if updated = definition then raise exception 'Marketplace listing join not found'; end if;
  execute updated;

  -- A saved account is a preference. Keep the live listing from being duplicated across accounts.
  definition := pg_get_functiondef('app.queue_seller_operation(uuid,text,jsonb,uuid)'::regprocedure);
  updated := regexp_replace(definition,
    '(if[[:space:]]+p_kind[[:space:]]*=[[:space:]]*''listing''[[:space:]]+then)',
    $replacement$\1
    if link.id is not null and link.account_id is distinct from app.listing_account_for(i) then
      raise exception '元のアカウントに出品・取引が残っています。元の取引を確認してから再出品してください。' using errcode='22023';
    end if;$replacement$, 'i');
  if updated = definition then raise exception 'Seller listing queue guard not found'; end if;
  execute updated;

  -- The same cancelled trade can arrive after the item has moved back to listing preparation.
  definition := pg_get_functiondef('app.sync_seller_observation(text,jsonb)'::regprocedure);
  updated := replace(definition, ' if state=''販売済'' then'||chr(10)||'  day:=', $replacement$
 if l.id is not null and not l.active and l.observed_status='キャンセル'
   and (trade is null or trade=l.trade_key or trade=ext) then return 'protected'; end if;
 if state='キャンセル' and i.status='商品登録前' and i.sold_on is null
   and l.active and trade is not null and trade=l.trade_key then
  update app.seller_listings set active=false,observed_status=state,observed_at=observed where id=l.id;
  update app.items set seller_cancelled_trade_key=trade,seller_cancelled_at=observed,
    marketplace_status_observed_at=observed where id=i.id;
  return 'updated';
 end if;
 if state='販売済' then
  day:=$replacement$);
  if updated = definition then raise exception 'Seller observation guard not found'; end if;
  execute updated;
end $migration$;

notify pgrst, 'reload schema';
