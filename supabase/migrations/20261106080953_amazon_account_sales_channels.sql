-- Keep legacy channel values for old clients and historical data.
alter type app.sales_channel add value if not exists 'FBA1';
alter type app.sales_channel add value if not exists 'FBA2';
alter type app.sales_channel add value if not exists '自己発送1';
alter type app.sales_channel add value if not exists '自己発送2';

-- Classify fulfillment without discarding the account stored on an item.
create function app.sales_channel_family(p_channel app.sales_channel)
returns app.sales_channel language sql immutable strict parallel safe set search_path='' as $$
 select case when p_channel::text in ('FBA1','FBA2') then 'FBA'::app.sales_channel
   when p_channel::text in ('自己発送1','自己発送2') then '自己発送'::app.sales_channel else p_channel end;
$$;
revoke all on function app.sales_channel_family(app.sales_channel) from public,anon;
grant execute on function app.sales_channel_family(app.sales_channel) to authenticated,service_role;

-- Payment histories already use SHA-256 of the seller ID as their account key.
-- Only explicit account channels constrain old historical reconciliation.
create function app.amazon_channel_account_key(p_channel app.sales_channel)
returns text language sql immutable strict parallel safe set search_path='' as $$
 select case when p_channel::text in ('FBA1','自己発送1') then '0488eda5964421b790fc7dade17b3cbdeea0ced17af746e1f58da2e8199929fb'
   when p_channel::text in ('FBA2','自己発送2') then 'aa469f79b88e99c9cce7a392cd506259919bc673e727044662747cca96304957' end;
$$;
revoke all on function app.amazon_channel_account_key(app.sales_channel) from public,anon;
grant execute on function app.amazon_channel_account_key(app.sales_channel) to authenticated,service_role;

-- Preserve the current action guards, permissions, notification and date logic;
-- expand only fulfillment predicates in these existing, reviewed functions.
do $migration$
declare f record; source text; patched text; count_functions integer:=0;
begin
 for f in select p.oid,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='app' and p.proname=any(array[
     'apply_amazon_sale','capture_shipping_request','claim_delivery_push','clear_prior_trade_shipping_date',
     'ensure_line_shipping_requests','line_shipping_eligible','perform_inventory_action','product_sale_summaries',
     'read_resource_snapshot','record_work_completion_date','validate_packing_photo_stage']) loop
  source:=pg_get_functiondef(f.oid);
  patched:=regexp_replace(source,
    $pattern$(\m(?:[a-z_]+\.)?sales_channel)(\s+(?:not\s+)?in\s*\(|\s*=\s*'(?:FBA|自己発送)')$pattern$,
    $replacement$app.sales_channel_family(\1)\2$replacement$,'g');
  if patched=source then raise exception 'Amazon channel predicate not found in %',f.proname; end if;
  if f.proname='apply_amazon_sale' then
   patched:=replace(patched,'  if (inventory.purchased_at is not null',
    $guard$  if app.amazon_channel_account_key(inventory.sales_channel) is not null and app.amazon_channel_account_key(inventory.sales_channel)<>p_account then
    return jsonb_build_object('status','review','reason','販売先のAmazonアカウントと取引が一致しません。'); end if;
  if (inventory.purchased_at is not null$guard$);
  end if;
  execute patched;
  count_functions:=count_functions+1;
 end loop;
 if count_functions<>11 then raise exception 'Expected eleven Amazon channel functions, got %',count_functions; end if;

 source:=pg_get_functiondef('app.apply_amazon_refund(text,text,text,uuid)'::regprocedure);
 patched:=replace(source,' select * into prior from app.amazon_refund_matches',
   $guard$ if app.amazon_channel_account_key(target.sales_channel) is not null and app.amazon_channel_account_key(target.sales_channel)<>p_account then
   return jsonb_build_object('status','review','reason','販売先のAmazonアカウントと取引が一致しません。'); end if;
 select * into prior from app.amazon_refund_matches$guard$);
 if patched=source then raise exception 'Amazon refund account guard location not found'; end if;
 execute patched;
end $migration$;

-- Reapply each view's existing security options explicitly. Output channel
-- values and grants retain their existing meaning and account suffix.
do $migration$
declare v text; source text; patched text;
begin
 foreach v in array array['v_amazon_unmatched_app_sales','v_deliverer_workload','v_delivery_notice_tasks','v_amazon_listing_feed'] loop
  source:=pg_get_viewdef(('app.'||v)::regclass,true);
  patched:=regexp_replace(source,$pattern$(items\.sales_channel)(\)?\s*::text\s*=\s*ANY)$pattern$,
    $replacement$app.sales_channel_family(\1)\2$replacement$,'g');
  patched:=replace(patched,'i.sales_channel = ANY','app.sales_channel_family(i.sales_channel) = ANY');
  patched:=replace(patched,'CASE i.sales_channel','CASE app.sales_channel_family(i.sales_channel)');
  if source=patched then raise exception 'Amazon channel predicate not found in view %',v; end if;
  execute format('create or replace view app.%I with (security_invoker=true%s) as %s',
    v,case when v='v_deliverer_workload' then ',security_barrier=true' else '' end,patched);
 end loop;
end $migration$;
notify pgrst,'reload schema';
