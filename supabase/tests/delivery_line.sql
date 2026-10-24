-- Isolated CI fixtures; never call LINE or marketplace endpoints.
begin;
do $$declare target_staff uuid;other_id uuid;begin
 select id into target_staff from app.staff where code='DD';select id into other_id from app.staff where code='HH';
 perform app.issue_delivery_line_code(target_staff,repeat('a',64));
 begin perform app.issue_delivery_line_code(target_staff,repeat('b',64));raise exception 'Rate limit bypassed';
 exception when raise_exception then if sqlerrm='Rate limit bypassed' then raise;end if;end;
 if not app.handle_delivery_line_event('link-first','link','U'||repeat('1',32),repeat('a',64)) then raise exception 'Valid link rejected';end if;
 if app.handle_delivery_line_event('link-first','link','U'||repeat('1',32),repeat('a',64)) then raise exception 'Webhook replay linked twice';end if;
 if exists(select 1 from app.delivery_line_codes where staff_id=target_staff) then raise exception 'Code not consumed';end if;
 perform app.issue_delivery_line_code(other_id,repeat('b',64));
 if app.handle_delivery_line_event('cross-staff','link','U'||repeat('1',32),repeat('b',64)) then raise exception 'Another staff stole LINE binding';end if;
 update app.delivery_line_codes set expires_at=now()-interval '1 second' where code_hash=repeat('b',64);
 if app.handle_delivery_line_event('expired','link','U'||repeat('2',32),repeat('b',64)) then raise exception 'Expired code linked';end if;
 if has_table_privilege('authenticated','app.delivery_line_links','select') or has_table_privilege('anon','app.delivery_line_codes','select')
 or has_function_privilege('authenticated','app.issue_delivery_line_code(uuid,text)','execute')
 or has_function_privilege('anon','app.handle_delivery_line_event(text,text,text,text)','execute') then raise exception 'LINE private data exposed';end if;
end $$;

update app.delivery_line_settings set enabled=true;
insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel,tracking_no,inspected_at,product_registered_at,status)
select n,(select id from app.staff where code='AA'),(select id from app.staff where code='DD'),current_date-10,'LINE fixture',1000,'メルカリ','メルカリ',
 'fixture',now(),now(),'出品中' from generate_series(998731,998734) n;
update app.items set status='取引中' where lot_seq between 998731 and 998734;
do $$declare n integer;row record;begin
 select count(*) into n from app.claim_delivery_line() where eligible;
 if n<>4 then raise exception 'Expected four eligible requests, got %',n;end if;
 if exists(select 1 from app.claim_delivery_line()) then raise exception 'Concurrent claim reused lease';end if;
 select * into row from app.delivery_line_outbox limit 1;
 perform app.finish_delivery_line(row.id,gen_random_uuid(),'sent',200);
 if exists(select 1 from app.delivery_line_outbox where id=row.id and state='sent') then raise exception 'Wrong lease acknowledged';end if;
end $$;
update app.delivery_line_outbox set next_attempt_at=now();
update app.items set shipped_on=current_date where lot_seq=998731;
update app.items set status='出品中' where lot_seq=998732;
update app.items set deliverer_id=(select id from app.staff where code='HH') where lot_seq=998733;
do $$declare n integer;begin
 select count(*) into n from app.claim_delivery_line() where eligible;
 if n<>1 then raise exception 'Shipped/cancelled/reassigned request eligible: %',n;end if;
 perform app.handle_delivery_line_event('blocked','unfollow','U'||repeat('1',32));
 if exists(select 1 from app.delivery_line_outbox where state in ('pending','sending')) then raise exception 'Blocked LINE kept pending requests';end if;
 perform app.unlink_delivery_line((select id from app.staff where code='DD'));
 if exists(select 1 from app.delivery_line_links) then raise exception 'Unlink failed';end if;
end $$;
rollback;

