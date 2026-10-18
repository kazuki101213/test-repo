-- Result checks only: never put an uncertain listing back into the publish queue.
create or replace function app.extension_seller_queue(p_account_ids text[]) returns jsonb
language plpgsql security definer set search_path=pg_catalog,app as $$
begin
 if auth.uid() is null or not app.is_admin() or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active) then raise exception '権限がありません' using errcode='42501';end if;
 return coalesce((select jsonb_agg(to_jsonb(q)) from (
  select o.*,i.sku inventory_sku,(o.status='uncertain') read_only_listing_check,l.external_id,coalesce(l.trade_url,l.url) url,l.trade_key
  from app.seller_operations o join app.items i on i.id=o.item_id left join app.seller_listings l on l.item_id=o.item_id and l.active
  where o.account_id=any(p_account_ids) and (o.status='queued' or (o.status='uncertain' and o.kind='listing'
    and o.result->>'read_check_state'='queued' and o.result->>'read_check_request' is not null and coalesce(o.result->>'read_check_attempt','')<>o.result->>'read_check_request'
    and i.status=o.expected_status and i.updated_at=o.expected_updated_at and i.sales_channel=o.channel and i.sold_on is null))
  order by case when o.status='queued' then 0 else 1 end,o.created_at limit 10
 ) q),'[]'::jsonb);
end $$;

create function app.request_listing_result_check(p_item_id uuid) returns uuid
language plpgsql security definer set search_path=pg_catalog,app as $$
declare i app.items;q app.seller_operations;
begin
 select * into i from app.items where id=p_item_id;
 if auth.uid() is null or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active)
  or not coalesce(app.is_admin() or i.deliverer_id=app.current_staff_id(),false) then raise exception '権限がありません' using errcode='42501';end if;
 select * into q from app.seller_operations where item_id=i.id and kind='listing' and status='uncertain' order by created_at desc limit 1 for update;
 if q.id is null or i.status is distinct from q.expected_status or i.updated_at is distinct from q.expected_updated_at or i.sales_channel is distinct from q.channel or i.sold_on is not null then raise exception '商品が更新されています。出品結果を確認してください';end if;
 if q.result->>'read_check_state' in ('queued','running') and (q.result->>'read_check_requested_at')::timestamptz>clock_timestamp()-interval '10 minutes' then return q.id;end if;
 update app.seller_operations set result=(result-'last_check_note')||jsonb_build_object('read_check_request',gen_random_uuid()::text,'read_check_state','queued','read_check_requested_at',clock_timestamp()) where id=q.id;
 return q.id;
end $$;

create function app.extension_claim_listing_result_check(p_id uuid,p_account_id text) returns boolean
language plpgsql security definer set search_path=pg_catalog,app as $$
begin
 if auth.uid() is null or not app.is_admin() or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active) then raise exception '権限がありません' using errcode='42501';end if;
 update app.seller_operations o set result=result||jsonb_build_object('read_check_attempt',result->>'read_check_request','read_check_state','running','read_check_requested_at',clock_timestamp(),'read_check_claimed_at',clock_timestamp())
 where id=p_id and account_id=p_account_id and kind='listing' and status='uncertain'
 and result->>'read_check_state'='queued' and result->>'read_check_request' is not null and coalesce(result->>'read_check_attempt','')<>result->>'read_check_request'
 and exists(select 1 from app.items i where i.id=o.item_id and i.status=o.expected_status and i.updated_at=o.expected_updated_at and i.sales_channel=o.channel and i.sold_on is null);
 return found;
end $$;

create function app.extension_finish_listing_result_check(p_id uuid,p_result jsonb) returns void
language plpgsql security definer set search_path=pg_catalog,app as $$
declare q app.seller_operations;i app.items;ext text:=p_result->>'external_id';u text:=p_result->>'url';observed timestamptz;
begin
 if auth.uid() is null or not app.is_admin() or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active) then raise exception '権限がありません' using errcode='42501';end if;
 if p_result is null or octet_length(p_result::text)>10000 then raise exception '確認結果が不正です';end if;
 select * into q from app.seller_operations where id=p_id for update;
 if q.kind='listing' and q.status='succeeded' and q.result->>'external_id'=ext and q.result->>'url'=u then return;end if;
 if q.id is null or q.kind<>'listing' or q.status<>'uncertain' or q.result->>'read_check_state' is distinct from 'running'
  or q.result->>'read_check_claimed_at' is null or (q.result->>'read_check_claimed_at')::timestamptz<clock_timestamp()-interval '10 minutes' then raise exception '確認処理の予約がありません';end if;
 if ext is null then
  update app.seller_operations set result=result||jsonb_build_object('read_check_state','done','last_check_note',left(coalesce(p_result->>'note','出品結果を確認できません'),400),'read_check_finished_at',clock_timestamp()) where id=q.id;
  return;
 end if;
 observed:=(p_result->>'observed_at')::timestamptz;
 if observed is null or observed<clock_timestamp()-interval '5 minutes' or observed>clock_timestamp()+interval '1 minute' or observed<q.created_at
  or regexp_replace(coalesce(p_result->>'verified_title',''),'[[:space:]　]+',' ','g')<>regexp_replace(q.payload->>'title','[[:space:]　]+',' ','g')
  or not ((q.channel='メルカリ' and ext~'^m[0-9]+$' and u='https://jp.mercari.com/item/'||ext) or (q.channel='ヤフオク' and ext~'^[a-z][0-9]+$' and u='https://page.auctions.yahoo.co.jp/jp/auction/'||ext)) or u is null then raise exception '出品の商品名・URLを確認できません';end if;
 select * into i from app.items where id=q.item_id for update;
 if lower(coalesce(p_result->>'verified_serial',''))<>lower(split_part(i.sku,'-',1)) or i.status is distinct from q.expected_status or i.updated_at is distinct from q.expected_updated_at or i.sales_channel is distinct from q.channel or i.sold_on is not null then raise exception '商品が更新されています。出品結果は変更しません';end if;
 if exists(select 1 from app.seller_listings where (item_id=i.id and active and (channel<>q.channel or account_id<>q.account_id or external_id<>ext)) or (channel=q.channel and external_id=ext and (item_id<>i.id or account_id<>q.account_id))) then raise exception '別の商品または出品情報と重複しています';end if;
 insert into app.seller_listings(item_id,channel,account_id,external_id,url,observed_at,observed_status) values(i.id,q.channel,q.account_id,ext,u,observed,'出品中')
 on conflict(channel,account_id,external_id) do update set active=true,observed_at=excluded.observed_at,observed_status='出品中';
 update app.items set status='出品中',product_registered_at=coalesce(product_registered_at,observed) where id=i.id;
 update app.seller_operations set status='succeeded',finished_at=clock_timestamp(),result=(result-'last_check_note')||p_result||jsonb_build_object('read_check_state','done','verified_read_only',true,'note','出品済みの商品を確認し、在庫へ反映しました') where id=q.id;
end $$;
revoke all on function app.extension_seller_queue(text[]),app.request_listing_result_check(uuid),app.extension_claim_listing_result_check(uuid,text),app.extension_finish_listing_result_check(uuid,jsonb) from public,anon;
grant execute on function app.extension_seller_queue(text[]),app.request_listing_result_check(uuid),app.extension_claim_listing_result_check(uuid,text),app.extension_finish_listing_result_check(uuid,jsonb) to authenticated;

-- Preserve invoker/RLS and the existing context fields, adding safe check progress.
do $migration$
declare definition text;
begin
 definition:=pg_get_functiondef('app.seller_operation_context(uuid)'::regprocedure);
 definition:=replace(definition,$old$else jsonb_build_object('note',q.result->>'note') end$old$,$new$else jsonb_strip_nulls(jsonb_build_object('note',q.result->>'note','read_check_state',q.result->>'read_check_state','read_check_requested_at',q.result->>'read_check_requested_at','last_check_note',q.result->>'last_check_note')) end$new$);
 execute definition;
end $migration$;
