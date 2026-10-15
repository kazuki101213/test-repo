\set ON_ERROR_STOP on
begin;
insert into auth.users(id,email) values('99660000-0000-0000-0000-000000000001','management-purchaser@example.invalid');
insert into app.profiles(user_id,staff_id) select '99660000-0000-0000-0000-000000000001',id from app.staff where code='EE';
set local role authenticated;
set local request.jwt.claim.sub='99660000-0000-0000-0000-000000000001';
do $$ declare report_name text; row_count bigint;
begin
  if app.current_role() <> 'purchaser' then raise exception 'Purchaser fixture missing'; end if;
  foreach report_name in array array['v_monthly_summary','v_stock_summary','v_deliverer_workload','v_antique_ledger','v_ledger_gaps','v_product_performance'] loop
    execute format('select count(*) from app.%I',report_name) into row_count;
    if row_count <> 0 then raise exception 'Purchaser can read management report %',report_name; end if;
  end loop;
  if (select count(*) from app.v_inventory_display)=0 then raise exception 'Purchaser lost inventory access'; end if;
  perform count(*) from app.spare_accessories;
end $$;
set local request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
do $$ begin
 if not app.management_reports_allowed() then raise exception 'Administrator lost report access'; end if;
 if (select count(*) from app.v_monthly_summary)=0 then raise exception 'Administrator report is empty'; end if;
end $$;
set local request.jwt.claim.sub='22222222-2222-2222-2222-222222222222';
do $$ begin
 if app.management_reports_allowed() or exists(select 1 from app.v_monthly_summary) then raise exception 'Deliverer can read management report'; end if;
end $$;
rollback;
