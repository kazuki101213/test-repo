-- Observing a listing does not imply that an assignee completed their work today.
do $$
declare
  d text := pg_get_functiondef('app.apply_seller_inventory_report(text,uuid,text,timestamptz,jsonb)'::regprocedure);
  start_anchor text := 'with report as materialized (';
  finish_anchor text := 'into result from changed;';
begin
  if strpos(d,start_anchor)=0 or strpos(d,finish_anchor)=0 then
    raise exception 'Unexpected seller inventory report function';
  end if;
  d := replace(d,'result jsonb;', 'result jsonb; previous_observation text := current_setting(''app.seller_inventory_observation'',true);');
  d := replace(d,start_anchor,'perform set_config(''app.seller_inventory_observation'',''on'',true); ' || start_anchor);
  d := replace(d,finish_anchor,finish_anchor || ' perform set_config(''app.seller_inventory_observation'',coalesce(previous_observation,''''),true);');
  execute d;
end $$;

do $$
declare
  d text := pg_get_functiondef('app.record_work_completion_date()'::regprocedure);
  anchor text := 'if new.packed_on is not null or old.packed_on is not null then return new;end if;';
begin
  if strpos(d, anchor) = 0 then
    raise exception 'Unexpected work completion date function';
  end if;
  execute replace(d,anchor,anchor || E'\n if current_setting(''app.seller_inventory_observation'',true) = ''on'' then return new;end if;');
end $$;

-- A cached management app must not still apply the superseded BUYABLE rule.
create or replace function app.apply_observed_amazon_self_listing(p_request_id uuid,p_expected_sku text)
returns boolean language sql security definer set search_path = '' as $$ select false $$;

notify pgrst, 'reload schema';
