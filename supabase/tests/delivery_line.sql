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

select app.unlink_delivery_line((select id from app.staff where code='DD'));
rollback;
