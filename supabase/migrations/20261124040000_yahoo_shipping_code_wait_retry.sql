-- 2026-11-24: ヤフオクの落札直後（落札者の支払い・配送方法の選択前）に発送コード取得が動くと、
-- 取引画面に配送コードの発行欄が無く「配送サイズを1件に特定できません」で止まる（2492）。
-- その後は同じ取引の失敗が残るため、梱包済みの自動発行が二度と動かなかった。
-- この「まだ発行欄が無い」止まり方（ボタンは押していない）に限り、20分あけて最大24回まで自動でやり直す。
-- やり直しの途中の停止は通知しない（待っているだけのため）。24回目で止まったときだけ通知する。

create or replace function app.yahoo_shipping_code_waiting_failure(p app.seller_operations)
returns boolean
language sql
immutable
set search_path to 'pg_catalog', 'app'
as $function$
  select p.kind = 'shipping_code' and p.status = 'failed'
    and p.result->>'phase' = 'shipping_code'
    and p.result#>>'{shipping_structure,host}' = 'contact.auctions.yahoo.co.jp'
    and (
      coalesce(p.result->>'note', '') like 'ヤフオク取引画面に配送コードの発行欄がまだありません%'
      or (
        p.result->>'note' = 'ヤフオク取引画面の配送サイズを1件に特定できません。コードは発行していません'
        and not exists(
          select 1 from jsonb_array_elements(
            case when jsonb_typeof(p.result#>'{shipping_structure,controls}') = 'array'
              then p.result#>'{shipping_structure,controls}' else '[]'::jsonb end) c
          where coalesce(c->>'label', '') ~ '品名|発送場所|配送コード|サイズ')
      )
    )
$function$;

create or replace function app.queue_packed_shipping_code(p_item_id uuid)
 returns boolean
 language plpgsql
 security definer
 set search_path to 'pg_catalog', 'app'
as $function$
declare
 i app.items;
 l app.seller_listings;
 settings jsonb;
 request_id uuid:=gen_random_uuid();
 allow_yahoo_preflight_retry boolean:=false;
 allow_mercari_preflight_retry boolean:=false;
 allow_yahoo_size_mismatch_retry boolean:=false;
 allow_yahoo_missing_dropoff_retry boolean:=false;
 allow_yahoo_wait_retry boolean:=false;
 retry_op uuid;
begin
 if auth.uid() is null or app.current_staff_id() is null or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active) then
  raise exception 'ログインが必要です' using errcode='42501';
 end if;
 select * into i from app.items where id=p_item_id for update;
 if i.id is null or not coalesce(app.is_admin() or i.deliverer_id=app.current_staff_id(),false) then
  raise exception '納品担当者または管理者のみ操作できます' using errcode='42501';
 end if;
 if i.status<>'取引中' or i.sales_channel not in ('メルカリ','ヤフオク') or i.packed_on is null or i.shipped_on is not null or i.sold_on is not null or i.seller_cancelled_at is not null then return false; end if;
 select * into l from app.seller_listings where item_id=i.id and active;
 if l.id is null or l.trade_key is null then return false; end if;

 -- Retry only this known pre-submit Yahoo size mismatch. The previous DOM
 -- guard raised before reserving/clicking the issuance button.
 if app.is_admin() and i.sales_channel='ヤフオク' and l.account_id='auctions-2' then
  select p.id into retry_op
  from app.seller_operations p
  where p.item_id=i.id and p.kind='shipping_code'
   and p.payload->>'trade_key'=l.trade_key and p.status='uncertain'
   and p.result->>'phase'='shipping_code'
   and p.result->>'note'='落札者が選択した配送サイズとアプリ設定の一致を確認できません'
   and p.result#>>'{shipping_structure,host}'='contact.auctions.yahoo.co.jp'
   and p.result#>>'{shipping_structure,path}'='/trade/top'
  for update;
  if retry_op is not null then
   if exists(select 1 from app.seller_operations o where o.item_id=i.id and o.id<>retry_op and o.status in ('queued','running','uncertain')) then return false; end if;
   update app.seller_operations
    set status='failed',finished_at=clock_timestamp(),
     result=result||jsonb_build_object('recovery_reason','size_mismatch_pre_submit_no_click')
    where id=retry_op and status='uncertain';
  end if;
 end if;

 select count(*)=1 into allow_yahoo_preflight_retry
 from app.seller_operations p where p.item_id=i.id and p.kind='shipping_code'
  and p.payload->>'trade_key'=l.trade_key and p.status='failed'
  and p.result->>'phase'='yahoo_shipping_preflight'
  and p.result->>'note'='発送操作のある取引タブを1件に確認できません';
 select count(*)=1 into allow_mercari_preflight_retry
 from app.seller_operations p where p.item_id=i.id and p.kind='shipping_code'
  and p.payload->>'trade_key'=l.trade_key and p.status='failed'
  and p.result->>'phase'='prepare'
  and p.result->>'note'='取引画面の発送情報の読み込みが時間切れになりました。コードは発行していません'
  and p.result#>>'{shipping_structure,host}'='jp.mercari.com'
  and p.result#>>'{shipping_structure,path}'='/transaction/[item]'
  and exists(select 1 from jsonb_array_elements(case when jsonb_typeof(p.result#>'{shipping_structure,controls}')='array' then p.result#>'{shipping_structure,controls}' else '[]'::jsonb end) c
   where c->>'tag'='BUTTON' and c->>'label'='サイズと発送場所を選択する');
 select count(*)=1 into allow_yahoo_size_mismatch_retry
 from app.seller_operations p where p.item_id=i.id and p.kind='shipping_code'
  and p.payload->>'trade_key'=l.trade_key and p.status='failed'
  and p.result->>'phase'='shipping_code'
  and p.result->>'note'='落札者が選択した配送サイズとアプリ設定の一致を確認できません'
  and p.result->>'recovery_reason'='size_mismatch_pre_submit_no_click';
 select count(*)=1 into allow_yahoo_missing_dropoff_retry
 from app.seller_operations p where p.item_id=i.id and p.kind='shipping_code'
  and p.payload->>'trade_key'=l.trade_key and p.status='failed'
  and p.result->>'phase'='shipping_code'
  and p.result->>'note'='入力欄を1件に確認できません：発送場所'
  and p.result->>'recovery_reason'='yahoo_missing_optional_dropoff_pre_submit_no_click'
  and p.result->>'stopped_before_publish'='true'
  and p.result#>>'{confirmation_evidence,clicked}'='false'
  and p.result#>>'{shipping_structure,host}'='contact.auctions.yahoo.co.jp'
  and p.result#>>'{shipping_structure,path}'='/trade/top';
 -- 落札者の支払い・配送方法の選択待ち：20分あけて最大24回。
 select i.sales_channel='ヤフオク' and count(*) between 1 and 23
   and coalesce(max(p.finished_at),'-infinity'::timestamptz) < clock_timestamp()-interval '20 minutes'
  into allow_yahoo_wait_retry
 from app.seller_operations p where p.item_id=i.id and p.payload->>'trade_key'=l.trade_key
  and app.yahoo_shipping_code_waiting_failure(p);
 if exists(
  select 1 from app.seller_operations o
  where o.item_id=i.id and (
   o.status in ('queued','running','uncertain')
   or (
    o.kind='shipping_code' and o.payload->>'trade_key'=l.trade_key and not (
     o.status='failed' and (
      (o.result->>'phase'='yahoo_shipping_preflight'
       and o.result->>'note'='発送操作のある取引タブを1件に確認できません'
       and allow_yahoo_preflight_retry)
      or
      (o.result->>'phase'='prepare'
       and o.result->>'note'='取引画面の発送情報の読み込みが時間切れになりました。コードは発行していません'
       and o.result#>>'{shipping_structure,host}'='jp.mercari.com'
       and o.result#>>'{shipping_structure,path}'='/transaction/[item]'
       and allow_mercari_preflight_retry)
      or
      (o.result->>'phase'='shipping_code'
       and o.result->>'note'='落札者が選択した配送サイズとアプリ設定の一致を確認できません'
       and o.result->>'recovery_reason'='size_mismatch_pre_submit_no_click'
       and allow_yahoo_size_mismatch_retry)
      or
      (o.result->>'phase'='shipping_code'
       and o.result->>'note'='入力欄を1件に確認できません：発送場所'
       and o.result->>'recovery_reason'='yahoo_missing_optional_dropoff_pre_submit_no_click'
       and o.result->>'stopped_before_publish'='true'
       and o.result#>>'{confirmation_evidence,clicked}'='false'
       and o.result#>>'{shipping_structure,host}'='contact.auctions.yahoo.co.jp'
       and o.result#>>'{shipping_structure,path}'='/trade/top'
       and allow_yahoo_missing_dropoff_retry)
      or
      (app.yahoo_shipping_code_waiting_failure(o) and allow_yahoo_wait_retry)
     )
    )
   )
  )
 ) then return false; end if;
 settings:=coalesce(app.seller_operation_context(i.id)->'shipping_defaults','{}'::jsonb);
 if (settings->>'size'='ネコポス' and settings->>'shippingMethod' is distinct from 'らくらくメルカリ便') or coalesce(settings->>'size','') not in ('60','80','100','120','140','160','180','200','ネコポス','宅急便コンパクト','ゆうパケットプラス','宅急便60〜160','宅急便180〜200','ゆうパック60〜100','ゆうパック120〜170','ゆうパケット')
  or coalesce(settings->>'shippingMethod','') not in ('らくらくメルカリ便','ゆうゆうメルカリ便','おてがる配送（ヤマト運輸）','おてがる配送（日本郵便）')
  or (settings->>'shippingMethod' in ('らくらくメルカリ便','おてがる配送（ヤマト運輸）') and coalesce(settings->>'dropoff','') not in ('セブンイレブン','ヤマト営業所'))
  or (settings->>'shippingMethod' in ('ゆうゆうメルカリ便','おてがる配送（日本郵便）') and coalesce(settings->>'dropoff','') not in ('ローソン','郵便局')) then return false; end if;
 perform app.queue_seller_operation(i.id,'shipping_code',settings||jsonb_build_object('trade_key',l.trade_key,'expected_revision',i.updated_at,'automatic_packed',true),request_id);
 return true;
exception when others then if sqlstate='42501' then raise; end if; return false;
end
$function$;

-- 通知：支払い待ちでの停止は、24回目（自動のやり直しが終わるとき）だけ通知する。
create or replace function app.notify_operation_failure()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare
  item_no text;
  label text;
  note text;
  body text;
begin
  if TG_TABLE_NAME = 'seller_operations' then
    if app.yahoo_shipping_code_waiting_failure(new)
      and (select count(*) from app.seller_operations p
           where p.item_id = new.item_id and p.payload->>'trade_key' = new.payload->>'trade_key'
             and app.yahoo_shipping_code_waiting_failure(p)) < 24 then
      return new;
    end if;
    label := case new.kind
      when 'listing' then '出品'
      when 'shipping_code' then '発送コード取得'
      when 'ship_notice' then '発送連絡'
      when 'verify_shipping' then '発送の受付確認'
      when 'message_sync' then '取引メッセージ取得'
      else new.kind end;
    note := new.result->>'note';
  else
    label := case new.kind
      when 'send' then '仕入れ先へのメッセージ送信'
      when 'read' then '仕入れ先メッセージの取得'
      else new.kind end;
    note := new.note;
    if coalesce(note, '') ~ '取り消' then return new; end if;
  end if;

  select nullif(split_part(i.sku, '-', 1), '') into item_no from app.items i where i.id = new.item_id;
  body := coalesce('【' || item_no || '】', '')
    || label
    || case when new.status = 'uncertain' then 'の結果を確認できません' else 'が止まりました' end
    || coalesce('：' || nullif(btrim(note), ''), '');

  begin
    perform app.record_sale_notice(
      jsonb_build_array('operation-' || new.status, TG_TABLE_NAME, new.id::text)::text,
      new.item_id,
      left(body, 250));
  exception when others then
    -- 通知に失敗しても、拡張機能の結果の記録は止めない。
    raise warning 'operation failure notice skipped: %', sqlerrm;
  end;
  return new;
end
$function$;

revoke all on function app.yahoo_shipping_code_waiting_failure(app.seller_operations) from public, anon;
revoke all on function app.notify_operation_failure() from public, anon, authenticated;
