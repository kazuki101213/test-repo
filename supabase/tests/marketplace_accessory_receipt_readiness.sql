begin;
select set_config('request.jwt.claims',jsonb_build_object('sub',(select p.user_id from app.profiles p join app.staff s on s.id=p.staff_id where s.role='admin' and s.is_active limit 1),'role','authenticated')::text,true);
set local role authenticated;
do $test$
declare v_parent uuid;v_child uuid;v_probe jsonb;v_ctx jsonb;v_token uuid;v_result jsonb;
begin
 insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel,marketplace_item_id,inspected_at,cleaned_at)
 values(990901,(select id from app.staff where code='AA'),(select id from app.staff where code='DD'),current_date,'accessory receipt test parent',100,'ヤフオク','メルカリ','receipt-parent-fixture',now(),now()) returning id into v_parent;
 insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel,marketplace_item_id,is_accessory,parent_item_id)
 values(990902,(select id from app.staff where code='AA'),(select id from app.staff where code='DD'),current_date,'accessory receipt test child',10,'ヤフオク','メルカリ','receipt-child-fixture',true,v_parent) returning id into v_child;
 v_probe=app.marketplace_extension_probe('ヤフオク','receipt-child-fixture');
 v_ctx=app.marketplace_receipt_context('ヤフオク','receipt-child-fixture');
 if (v_probe->>'count')::int<>1 or v_probe->'items'->0->>'inspected_at' is not null or v_probe->'items'->0->>'cleaned_at' is not null then raise exception 'Tracking probe or actual accessory records changed';end if;
 if (v_ctx->'items'->0->>'receipt_ready')::boolean is not true or v_ctx->'items'->0->>'receipt_source'<>'parent' then raise exception 'Parent readiness omitted';end if;
 update app.items set parent_item_id=null where id=v_child;
 if (app.marketplace_receipt_context('ヤフオク','receipt-child-fixture')->'items'->0->>'receipt_ready')::boolean is true then raise exception 'Unlinked accessory became eligible';end if;
 update app.items set parent_item_id=v_parent where id=v_child;
 v_result=app.marketplace_extension_receipt('reserve','ヤフオク','receipt-child-fixture','fixture-account');
 if (v_result->>'eligible')::boolean is not true then raise exception 'Parent-ready reservation failed: %',v_result->>'reason';end if;
 v_token=(v_result->>'token')::uuid;
 update app.items set cleaned_at=null where id=v_parent;
 begin perform app.marketplace_extension_receipt('begin','ヤフオク','receipt-child-fixture','fixture-account',v_token);raise exception 'Missing parent cleaning allowed submission';
 exception when raise_exception then if sqlerrm='Missing parent cleaning allowed submission' then raise;end if;end;
 update app.items set cleaned_at=now() where id=v_parent;
 perform app.marketplace_extension_receipt('begin','ヤフオク','receipt-child-fixture','fixture-account',v_token);
 perform app.marketplace_extension_receipt('unknown','ヤフオク','receipt-child-fixture','fixture-account',v_token,'fixture unknown; never retry');
 if (app.marketplace_extension_receipt('reserve','ヤフオク','receipt-child-fixture','fixture-account')->>'eligible')::boolean is true then raise exception 'Unknown receipt resent';end if;
 if exists(select 1 from app.items where id=v_child and (inspected_at is not null or cleaned_at is not null)) then raise exception 'Accessory history was falsified';end if;
end $test$;
set local role anon;
do $test$begin
 begin perform app.marketplace_receipt_context('ヤフオク','receipt-child-fixture');raise exception 'Anonymous RPC allowed';
 exception when insufficient_privilege then null;end;
end $test$;
reset role;
select set_config('request.jwt.claims',jsonb_build_object('sub',(select p.user_id from app.profiles p join app.staff s on s.id=p.staff_id where s.role<>'admin' and s.is_active limit 1),'role','authenticated')::text,true);
set local role authenticated;
do $test$begin
 begin perform app.marketplace_receipt_context('ヤフオク','receipt-child-fixture');raise exception 'Nonadmin RPC allowed';
 exception when raise_exception then if sqlerrm='Nonadmin RPC allowed' then raise;end if;end;
end $test$;
reset role;
rollback;
select 'passed: parent readiness, unlinked exclusion, submit-time recheck, unknown no-resend, untouched accessory history, anon/nonadmin refusal; all fixtures rolled back' as result;
