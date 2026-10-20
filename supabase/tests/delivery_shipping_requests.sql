-- Disposable, rolled-back fixtures; no marketplace or push network calls.
begin;
insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel,tracking_no,inspected_at,product_registered_at,status)
select n,(select id from app.staff where code='AA'),(select id from app.staff where code='DD'),current_date-10,'shipping request fixture',1000,'PayPayフリマ',
 case n when 998421 then 'メルカリ'::app.sales_channel when 998422 then 'ヤフオク'::app.sales_channel when 998423 then '自己発送'::app.sales_channel else 'FBA'::app.sales_channel end,
 'fixture',now(),now(),'出品中' from generate_series(998421,998424) n;
insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,is_accessory)
 select 998421,(select id from app.staff where code='AA'),(select id from app.staff where code='DD'),current_date-10,'linked accessory fixture',100,'PayPayフリマ',true;
create temporary table shipping_probe as select id,lot_seq from app.items where lot_seq between 998421 and 998424 and not is_accessory;
grant select on shipping_probe to authenticated;
insert into app.delivery_push_subscriptions(staff_id,endpoint,p256dh,auth,base_url,created_at,app_kind)
 select id,'https://web.push.apple.com/shipping-fixture','fixture-public','fixture-auth','https://test-repo-delivery.vercel.app/',now()-interval '2 days','delivery' from app.staff where code='DD';
update app.items set marketplace_item_id='z694525406' where lot_seq=998421 and not is_accessory;
update app.items set status='取引中' where id in(select id from shipping_probe);
do $$begin
 if (select count(*) from app.delivery_shipping_tasks t join shipping_probe p on p.id=t.item_id)<>3 then raise exception 'Shipping task missing, FBA or accessory included';end if;
 if (select count(*) from app.delivery_push_events e join shipping_probe p on p.id=e.item_id join app.staff s on s.id=e.staff_id where e.kind='shipping' and s.code='DD')<>3 then raise exception 'Assigned shipping push missing/duplicated';end if;
 if (select count(*) from app.claim_delivery_push() where kind='shipping' and lot_seq between 998421 and 998424 and eligible)<>3 then raise exception 'Shipping push eligibility incorrect';end if;
end $$;
update app.items set status='取引中' where id in(select id from shipping_probe);
do $$begin
 if (select count(*) from app.delivery_shipping_tasks t join shipping_probe p on p.id=t.item_id)<>3 then raise exception 'Unchanged observation duplicated shipping task';end if;
end $$;
set local role authenticated;
set local request.jwt.claim.sub='22222222-2222-2222-2222-222222222222';
do $$declare notice record;payload jsonb;begin
 if (select count(*) from app.v_delivery_notice_tasks where kind='shipping' and item_id in(select id from shipping_probe))<>3 then raise exception 'Assignee shipping cards missing';end if;
 if not exists(select 1 from app.v_delivery_notice_tasks where lot_seq=998421 and kind='shipping' and marketplace_item_id='z694525406' and marketplace='PayPayフリマ') then raise exception 'Card product identity lost';end if;
 payload:=app.read_resource_snapshot('return_tasks');
 if not exists(select 1 from jsonb_array_elements(payload->'rows') r where r->>'kind'='shipping' and (r->>'lot_seq')::int=998421) then raise exception 'Existing bounded snapshot omits shipping';end if;
 select * into notice from app.v_delivery_notice_tasks where kind='shipping' and lot_seq=998421;
 perform app.complete_delivery_notice(notice.id,notice.item_id);perform app.complete_delivery_notice(notice.id,notice.item_id);
 if exists(select 1 from app.v_delivery_notice_tasks where id=notice.id) then raise exception 'Completed shipping card remains';end if;
 if not exists(select 1 from app.items where id=notice.item_id and status='取引中' and shipped_on is null) then raise exception 'Completing notice shipped the product';end if;
 begin insert into app.delivery_shipping_tasks(item_id) values(notice.item_id);raise exception 'Client inserted shipping task';exception when insufficient_privilege then null;end;
end $$;
set local request.jwt.claim.sub='33333333-3333-3333-3333-333333333333';
do $$begin
 if exists(select 1 from app.v_delivery_notice_tasks where kind='shipping' and item_id in(select id from shipping_probe)) then raise exception 'Other staff read shipping cards';end if;
 begin perform app.complete_delivery_notice('shipping:forged',(select id from shipping_probe where lot_seq=998422));raise exception 'Other staff completed shipping';exception when insufficient_privilege then null;end;
end $$;
set local role postgres;
update app.items set status='出品中' where id=(select id from shipping_probe where lot_seq=998422);
update app.items set shipped_on=current_date where id=(select id from shipping_probe where lot_seq=998423);
update app.delivery_push_deliveries d set state='pending',next_attempt_at=now() from app.delivery_push_events e where d.event_id=e.id and e.item_id in(select id from shipping_probe) and e.kind='shipping';
do $$begin
 if exists(select 1 from app.claim_delivery_push() where kind='shipping' and lot_seq between 998421 and 998424 and eligible) then raise exception 'Completed/cancelled/shipped notice still pushes';end if;
end $$;
set local role authenticated;
set local request.jwt.claim.sub='22222222-2222-2222-2222-222222222222';
do $$begin
 if exists(select 1 from app.v_delivery_notice_tasks where kind='shipping' and item_id in(select id from shipping_probe)) then raise exception 'Cancelled or shipped card remains';end if;
end $$;
set local role postgres;
update app.items set status='取引中' where id=(select id from shipping_probe where lot_seq=998422);
update app.delivery_shipping_tasks set created_at=clock_timestamp()-interval '2 days' where item_id=(select id from shipping_probe where lot_seq=998422) and resolved_at is null;
set local role authenticated;
do $$begin
 if (select count(*) from app.v_delivery_notice_tasks where kind='shipping' and lot_seq=998422)<>1 then raise exception 'New trading episode hidden by older notice or expiry';end if;
end $$;
set local role postgres;
update app.delivery_shipping_tasks set created_at=now()-interval '72 hours' where item_id=(select id from shipping_probe where lot_seq=998422) and resolved_at is null;
set local role authenticated;
do $begin
 if exists(select 1 from app.v_delivery_notice_tasks where kind='shipping' and lot_seq=998422) then raise exception 'Shipping still visible after 72 hours';end if;
end $;
set local role anon;
do $$begin
 begin perform 1 from app.delivery_shipping_tasks;raise exception 'Anonymous shipping read allowed';exception when insufficient_privilege then null;end;
end $$;
rollback;
