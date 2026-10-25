begin;
insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace)
values(997611,(select id from app.staff where code='AA'),(select id from app.staff where code='DD'),current_date-10,'daily price ledger fixture',1000,'メルカリ');
insert into app.marketplace_price_changes(channel,external_id,day,account_id,item_id,token,before_price,after_price,title,state)
select 'メルカリ','m997611',current_date,'mercari-2',id,'99761111-1111-4111-8111-111111111111',1000,900,'【997611】fixture','submitting' from app.items where lot_seq=997611;
do $$begin
 if has_function_privilege('anon','app.marketplace_price_candidates(text)','execute') or has_table_privilege('anon','app.marketplace_price_changes','select') then raise exception 'anonymous price access';end if;
 if not (select relrowsecurity from pg_class where oid='app.marketplace_price_changes'::regclass) then raise exception 'price ledger lacks RLS';end if;
end $$;
set local role authenticated;
set local request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
do $$begin
 begin perform app.marketplace_price_record('mercari-1','m997611','complete',current_date,p_token:='99761111-1111-4111-8111-111111111111');raise exception 'wrong account accepted';exception when raise_exception then if sqlerrm not like '予約%' then raise;end if;end;
 begin perform app.marketplace_price_record('mercari-2','m997611','complete',current_date,p_token:='99761111-1111-4111-8111-111111111112');raise exception 'wrong token accepted';exception when raise_exception then if sqlerrm not like '予約%' then raise;end if;end;
 perform app.marketplace_price_record('mercari-2','m997611','unknown',current_date,p_token:='99761111-1111-4111-8111-111111111111',p_note:='fixture unknown');
 begin perform app.marketplace_price_record('mercari-2','m997611','failed',current_date,p_token:='99761111-1111-4111-8111-111111111111');raise exception 'unknown automatically cleared';exception when raise_exception then if sqlerrm not like '送信状態%' then raise;end if;end;
 if not exists(select 1 from app.marketplace_price_changes where external_id='m997611' and state='unknown') then raise exception 'unknown state lost';end if;
 if exists(select 1 from app.items where lot_seq=997611 and sold_on is not null) then raise exception 'price operation changed sale';end if;
end $$;
rollback;
