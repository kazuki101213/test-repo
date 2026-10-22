-- Queued requests still expire after 30 minutes. Accepted scans may need more
-- time because existing pacing and per-item purchase-date checks are preserved.
do $$ declare definition text; old_text text:='set status=''running'',claim_token=gen_random_uuid()'; begin
 definition:=pg_get_functiondef('app.purchase_sync(text,uuid,uuid,uuid,jsonb)'::regprocedure);
 if position(old_text in definition)=0 then raise exception 'Purchase sync claim definition changed';end if;
 execute replace(definition,old_text,old_text||',expires_at=now()+interval ''2 hours''');
end $$;
update app.purchase_sync_requests set expires_at=greatest(expires_at,created_at+interval '2 hours') where status='running';
