begin;
insert into auth.users(id,email) values('99990000-0000-0000-0000-000000000001','ai-keywords@example.invalid');
insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel)
values(998991,(select id from app.staff where code='AA'),(select id from app.staff where code='DD'),current_date,'AI fixture',1000,'ヤフオク','メルカリ');
do $$
declare item uuid; actor uuid:='99990000-0000-0000-0000-000000000001'; result jsonb; token text;
begin
 select id into item from app.items where lot_seq=998991;
 if has_table_privilege('authenticated','app.listing_ai_keywords','SELECT') or has_function_privilege('authenticated','app.claim_listing_ai_keywords(uuid,text,uuid,boolean)','EXECUTE') then raise exception 'Client can bypass Edge Function';end if;
 result:=app.claim_listing_ai_keywords(item,repeat('a',64),actor);token:=result->>'claim';
 if token is null then raise exception 'First claim missing';end if;
 if not (app.claim_listing_ai_keywords(item,repeat('a',64),actor)->>'wait')::boolean then raise exception 'Duplicate generation permitted';end if;
 update app.listing_ai_keywords set state='ready',keywords='既存語 AI語' where item_id=item;
 if not (app.claim_listing_ai_keywords(item,repeat('a',64),actor)->>'cached')::boolean then raise exception 'Cache not reused';end if;
 update app.listing_ai_keywords set attempted_at=now()-interval '1 minute' where item_id=item;
 result:=app.claim_listing_ai_keywords(item,repeat('a',64),actor,true);
 if result->>'claim'=token or result->>'claim' is null then raise exception 'Force did not claim separately';end if;
 if (select count(*) from app.listing_ai_attempts where actor_id=actor)<>2 then raise exception 'Repeated calls do not consume quota';end if;
 insert into app.listing_ai_attempts(claim_id,actor_id) select gen_random_uuid(),actor from generate_series(1,18);
 if not (app.claim_listing_ai_keywords(item,repeat('b',64),actor)->>'limited')::boolean then raise exception 'Hourly quota ignored';end if;
 if not (app.claim_listing_ai_keywords(item,repeat('a',64),actor)->>'wait')::boolean then raise exception 'Pending request not locked';end if;
 update app.listing_ai_keywords set state='ready' where item_id=item;
 if not (app.claim_listing_ai_keywords(item,repeat('a',64),actor)->>'cached')::boolean then raise exception 'Quota must allow cached reads';end if;
end $$;
rollback;
