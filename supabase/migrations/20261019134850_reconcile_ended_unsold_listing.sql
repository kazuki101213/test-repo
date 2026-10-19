-- Resolve only an ended, unsold listing proven in the original seller account.
-- The existing authorization, reservation, revision and exact URL checks stay in force.
do $patch$
declare d text; marker text := ' if exists(select 1 from app.seller_listings where (item_id=i.id and active'; addition text := $body$
 if p_result->>'ended_without_sale'='true' then
  if q.channel<>'ヤフオク' or p_result->>'account_id' is distinct from q.account_id
   or p_result->>'ownership_source' is distinct from 'seller_closed_list'
   or p_result->'bid_count' is distinct from '0'::jsonb then raise exception '元アカウントの出品終了・入札なしを確認してください';end if;
  if exists(select 1 from app.seller_listings where item_id=i.id and active) then raise exception '有効な出品の紐付けがあります';end if;
  update app.seller_operations set status='failed',finished_at=clock_timestamp(),result=(result-'last_check_note')||p_result||jsonb_build_object('read_check_state','done','verified_read_only',true,'note','出品終了・入札なしを確認しました。自動再出品はしません','read_check_finished_at',clock_timestamp()) where id=q.id;
  return;
 end if;
$body$;
begin
 select pg_get_functiondef('app.extension_finish_listing_result_check(uuid,jsonb)'::regprocedure) into d;
 if strpos(d,marker)=0 then raise exception 'Listing result check definition changed; review before patching';end if;
 d:=replace(d,marker,addition||marker);
 d:=replace(d,'q.status=''succeeded'' and q.result->>','(q.status=''succeeded'' or q.status=''failed'' and q.result->>''ended_without_sale''=''true'') and q.result->>');
 execute d;
end $patch$;
