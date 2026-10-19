begin;
set local role authenticated;
set local request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel,tracking_no,status)
select 996801,(select id from app.staff where code='AA'),(select id from app.staff where code='DD'),current_date,'Report photo fixture',1000,'メルカリ','メルカリ','fixture','検品中';
set local role postgres;
insert into app.malfunction_report_photos(id,item_id,request_id,uploaded_by,drive_file_id,sort_order)
select '99680100-0000-0000-0000-000000000001',id,'99680100-0000-0000-0000-000000000002',deliverer_id,'fixture_private_file_123',0 from app.items where lot_seq=996801;
set local role authenticated;
set local request.jwt.claim.sub='22222222-2222-2222-2222-222222222222';
do $$begin
 if exists(select 1 from app.malfunction_report_photos where request_id='99680100-0000-0000-0000-000000000002') then raise exception 'Unsubmitted attachment leaked';end if;
 begin
  perform app.submit_malfunction_report((select id from app.items where lot_seq=996801),'検品中','Missing photo','99680100-0000-0000-0000-000000000002',array['99680100-0000-0000-0000-000000000099']::uuid[]);
  raise exception 'Missing photo accepted';
 exception when insufficient_privilege then null;end;
 if (select status from app.items where lot_seq=996801)<>'検品中' then raise exception 'Failed attachment changed state';end if;
end $$;
select app.submit_malfunction_report(id,'検品中','本体の動作不良です。','99680100-0000-0000-0000-000000000002',array['99680100-0000-0000-0000-000000000001']::uuid[]) from app.items where lot_seq=996801;
select app.submit_malfunction_report(id,'検品中','本体の動作不良です。','99680100-0000-0000-0000-000000000002',array['99680100-0000-0000-0000-000000000001']::uuid[]) from app.items where lot_seq=996801;
do $$begin
 if (select count(*) from app.inventory_workflow_events where id='99680100-0000-0000-0000-000000000002')<>1 then raise exception 'Retry duplicated report';end if;
 if (select count(*) from app.read_malfunction_report_photos((select id from app.items where lot_seq=996801)))<>1 then raise exception 'Reporter photo not visible';end if;
 begin update app.malfunction_report_photos set drive_file_id='replacement_forbidden' where id='99680100-0000-0000-0000-000000000001';raise exception 'Attachment writable';exception when insufficient_privilege then null;end;
end $$;
set local request.jwt.claim.sub='33333333-3333-3333-3333-333333333333';
do $$begin
 if exists(select 1 from app.malfunction_report_photos where request_id='99680100-0000-0000-0000-000000000002') then raise exception 'Other assignee read photos';end if;
 begin perform app.submit_malfunction_report('00000000-0000-0000-0000-000000000001','検品中','Forbidden','99680100-0000-0000-0000-000000000002',array['99680100-0000-0000-0000-000000000001']::uuid[]);raise exception 'Other assignee attached photos';exception when insufficient_privilege then null;end;
end $$;
set local request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
do $$begin if (select count(*) from app.read_malfunction_report_photos((select id from app.items where lot_seq=996801)))<>1 then raise exception 'Manager cannot read report photo';end if;end $$;
select app.perform_inventory_action(id,'send_back','動作不良') from app.items where lot_seq=996801;
select app.perform_inventory_action(id,'report','検品中','別の報告') from app.items where lot_seq=996801;
do $$begin if exists(select 1 from app.read_malfunction_report_photos((select id from app.items where lot_seq=996801))) then raise exception 'New report reused old photos';end if;end $$;
set local role postgres;
update app.staff set is_active=false where code='DD';
set local role authenticated;
set local request.jwt.claim.sub='22222222-2222-2222-2222-222222222222';
do $$begin
 if exists(select 1 from app.malfunction_report_photos where request_id='99680100-0000-0000-0000-000000000002') then raise exception 'Inactive staff read private photos';end if;
 begin perform app.submit_malfunction_report('00000000-0000-0000-0000-000000000001','検品中','Forbidden','99680100-0000-0000-0000-000000000002',array['99680100-0000-0000-0000-000000000001']::uuid[]);raise exception 'Inactive staff submitted report';exception when insufficient_privilege then null;end;
end $$;
rollback;
