begin;
select set_config('request.jwt.claim.sub',(select p.user_id from app.profiles p join app.staff s on s.id=p.staff_id where s.role='admin' and s.is_active limit 1)::text,true);
select set_config('request.jwt.claims',jsonb_build_object('sub',current_setting('request.jwt.claim.sub'),'role','authenticated')::text,true);
set local role authenticated;
do $test$
declare v_source uuid;v_target uuid;v_alloc uuid;v_other uuid;v_ctx jsonb;v_r jsonb;v_token uuid;
begin
 insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel,marketplace_item_id,inspected_at,cleaned_at)
 values(991001,(select id from app.staff where code='AA'),(select id from app.staff where code='DD'),current_date,'receipt group original',100,'ヤフオク','メルカリ','receipt-group-fixture',now(),now()) returning id into v_source;
 insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel,marketplace_item_id)
 values(991002,(select id from app.staff where code='AA'),(select id from app.staff where code='DD'),current_date,'receipt group destination',100,'ヤフオク','メルカリ','receipt-other-fixture') returning id into v_target;
 insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel,marketplace_item_id,is_accessory,parent_item_id)
 values(991003,(select id from app.staff where code='AA'),(select id from app.staff where code='DD'),current_date,'receipt allocated remote',0,'ヤフオク','メルカリ','receipt-group-fixture',true,v_target) returning id into v_alloc;
 if (app.marketplace_receipt_context('ヤフオク','receipt-group-fixture')->>'count')::int<>2 then raise exception 'Unproven duplicate was accepted';end if;
 insert into app.spare_accessories(owner_staff_id,purchased_at,title,cost_amount,marketplace,marketplace_item_id,used_for_item_id)
 values((select id from app.staff where code='AA'),current_date,'receipt allocation proof',0,'ヤフオク','receipt-group-fixture',v_target);
 v_ctx=app.marketplace_receipt_context('ヤフオク','receipt-group-fixture');
 if (v_ctx->>'count')::int<>1 or (v_ctx->>'inventory_count')::int<>2 or (v_ctx->>'receipt_group_size')::int<>2 then raise exception 'Verified allocation did not resolve to one purchase';end if;
 if (app.marketplace_extension_probe('ヤフオク','receipt-group-fixture')->>'count')::int<>2 then raise exception 'Tracking count was weakened';end if;
 update app.items set cleaned_at=null where id=v_source;
 if (app.marketplace_receipt_context('ヤフオク','receipt-group-fixture')->>'count')::int<>2 then raise exception 'Unchecked original purchase was accepted';end if;
 update app.items set cleaned_at=now() where id=v_source;
 v_r=app.marketplace_extension_receipt('reserve','ヤフオク','receipt-group-fixture','fixture-account');
 if (v_r->>'eligible')::boolean is not true then raise exception 'Group reservation rejected';end if;
 v_token=(v_r->>'token')::uuid;
 perform app.marketplace_extension_receipt('begin','ヤフオク','receipt-group-fixture','fixture-account',v_token);
 perform app.marketplace_extension_receipt('complete','ヤフオク','receipt-group-fixture','fixture-account',v_token,'fixture complete');
 if (app.marketplace_extension_receipt('reserve','ヤフオク','receipt-group-fixture','fixture-account')->>'eligible')::boolean is true then raise exception 'Same purchase evaluated twice';end if;
 insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel,marketplace_item_id,is_accessory)
 values(991004,(select id from app.staff where code='AA'),(select id from app.staff where code='DD'),current_date,'unproven extra duplicate',0,'ヤフオク','メルカリ','receipt-group-fixture',true) returning id into v_other;
 if (app.marketplace_receipt_context('ヤフオク','receipt-group-fixture')->>'count')::int<>3 then raise exception 'Unverified extra inventory ignored';end if;
 if exists(select 1 from app.items where id=v_alloc and (inspected_at is not null or cleaned_at is not null)) then raise exception 'Allocated item history changed';end if;
end $test$;
reset role;
rollback;
select 'passed: same-purchase allocation grouping, no unproven duplicates, original inspection required, tracking unchanged, one receipt only, history unchanged, rollback' as result;
