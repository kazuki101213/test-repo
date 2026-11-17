-- Rebuild a missing LINE request only for the verified active marketplace trade.
create function app.reconcile_line_shipping_tasks(p_account_ids text[])
returns void language plpgsql set search_path='' as $function$
declare target record;
begin
 for target in
  select i.id, l.trade_key
  from app.items i join app.seller_listings l on l.item_id=i.id
   and l.active and l.channel=i.sales_channel and l.trade_key=i.seller_trade_key
  where l.account_id=any(p_account_ids)
   and app.sales_channel_family(i.sales_channel) in ('メルカリ','ヤフオク')
   and i.status='取引中' and i.shipped_on is null and i.sold_on is null and i.seller_cancelled_at is null
   and (not i.is_accessory or app.is_standalone_accessory_serial(i.sku,i.lot_seq))
   and exists(select 1 from app.staff s join app.delivery_line_links link on link.staff_id=s.id
    where s.id=i.deliverer_id and s.is_active and not link.blocked)
   and not exists(select 1 from app.seller_operations n where n.item_id=i.id and n.account_id=l.account_id
    and n.channel=l.channel and n.kind='ship_notice' and n.status='succeeded' and n.result->>'notified'='true'
    and n.payload->>'trade_key'=l.trade_key)
   and not exists(select 1 from app.delivery_shipping_tasks t join app.delivery_line_outbox o on o.task_id=t.id
    where t.item_id=i.id and o.trade_key=l.trade_key and o.purpose='shipment' and o.sent_at is not null)
   and not exists(select 1 from app.delivery_shipping_tasks t where t.item_id=i.id and t.resolved_at is null
    and (not exists(select 1 from app.delivery_line_outbox o where o.task_id=t.id and o.purpose='shipment' and o.trade_key is not null)
     or exists(select 1 from app.delivery_line_outbox o where o.task_id=t.id and o.purpose='shipment' and o.trade_key=l.trade_key)))
  order by i.id for update of i skip locked
 loop
  -- An open, unbound task may safely attach to the current active trade. Only
  -- close tasks that are explicitly tied to a different trade.
  update app.delivery_shipping_tasks t set resolved_at=clock_timestamp()
   where t.item_id=target.id and t.resolved_at is null
   and exists(select 1 from app.delivery_line_outbox o where o.task_id=t.id and o.purpose='shipment'
    and o.trade_key is not null and o.trade_key<>target.trade_key)
   and not exists(select 1 from app.delivery_line_outbox o where o.task_id=t.id and o.purpose='shipment'
    and o.trade_key=target.trade_key);
  insert into app.delivery_shipping_tasks(item_id) values(target.id)
   on conflict(item_id) where resolved_at is null do nothing;
 end loop;
end;
$function$;
revoke all on function app.reconcile_line_shipping_tasks(text[]) from public,anon,authenticated;

do $migration$
declare
 prepare text := pg_get_functiondef('app.extension_prepare_line_shipping(text[],uuid,text)'::regprocedure);
 media text := pg_get_functiondef('app.line_shipping_media(uuid)'::regprocedure);
 context_def text := pg_get_functiondef('app.line_shipping_context(uuid)'::regprocedure);
 old_prepare text := ' if p_item_id is null then perform app.ensure_line_shipping_requests(); end if;';
 old_media text := '   and op.created_at>=t.created_at-interval ''5 minutes''';
 old_result text := $old$ return jsonb_build_object('queued',n);$old$;
begin
 if strpos(prepare,old_prepare)=0 or strpos(prepare,old_result)=0 or strpos(media,old_media)=0 then
  raise exception 'Expected LINE shipping function definition not found';
 end if;
 -- The operation is still bound to the item, current account and exact trade
 -- and delivery settings. An already-issued code can predate a recovered task.
 execute replace(media,old_media,'');
 prepare := replace(prepare,old_prepare,$body$ if p_item_id is null then
  perform app.reconcile_line_shipping_tasks(p_account_ids);
  perform app.ensure_line_shipping_requests();
  -- A media error before the prepared payload was saved did not call LINE.
  -- Re-arm it on a later patrol, while retaining the same retry key.
  update app.delivery_line_outbox q set state='pending',attempts=0,
   next_attempt_at=clock_timestamp(),first_attempt_at=null,lease=null,
   last_error='通知画像の準備を再試行しています'
  from app.delivery_shipping_tasks t join app.seller_listings l on l.item_id=t.item_id and l.active
  where q.task_id=t.id and l.trade_key=q.trade_key and l.account_id=any(p_account_ids)
   and q.purpose='shipment' and q.state='failed' and q.sent_at is null
   and q.attempts>0 and q.last_status is null and q.message_payload is null
   and app.line_shipping_eligible(q.id)
   and jsonb_array_length(app.line_shipping_media(q.id)->'photoPaths')=2;
 end if;$body$);
 if strpos(prepare,'prior.result->>''phase'' is distinct from ''prepare''')=0 then
  raise exception 'Expected preflight retry guard not found';
 end if;
 prepare := replace(prepare,$old$or prior.result->>'phase' is distinct from 'prepare'
       or coalesce(prior.result->>'note','') not in (
         '取引画面の発送情報の読み込みが時間切れになりました。コードは発行していません',
         '画面確認待ち: 待機中にタブが変更されたため停止しました'
       )$old$,$new$or not (
         (prior.result->>'phase' is not distinct from 'prepare' and coalesce(prior.result->>'note','') in (
           '取引画面の発送情報の読み込みが時間切れになりました。コードは発行していません',
           '画面確認待ち: 待機中にタブが変更されたため停止しました'
         ))
         or prior.result->>'note' is not distinct from '商品または取引が変更されたため実行しませんでした'
       )$new$);
 prepare := replace(prepare,old_result,$body$ if p_item_id is null then
  return jsonb_build_object('queued',n,'automaticPending',(
   select count(*) from app.seller_operations job
   where job.account_id=any(p_account_ids) and job.status='queued' and job.kind='shipping_code'
    and job.payload ? 'automatic_line'));
 end if;
 return jsonb_build_object('queued',n);$body$);
 execute prepare;
 if strpos(context_def,$old$  when q.state='failed' then 'LINE送信に失敗しました。設定を確認してください'$old$)=0 then
  raise exception 'Expected LINE status display not found';
 end if;
 context_def := replace(context_def,$old$  when q.state='failed' then 'LINE送信に失敗しました。設定を確認してください'$old$,$new$  when q.state in ('failed','pending') and q.attempts>0 and q.last_status is null and q.message_payload is null then
   'LINE送信前に通知写真・発送コードの準備が止まりました'
  when q.state='failed' then 'LINE送信に失敗しました。設定を確認してください'$new$);
 context_def := replace(context_def,$old$  when p.model_photo_id is null or p.overview_photo_id is null then '通知写真を指定してください'
  when q.id is null then 'この取引のLINE発送依頼は未送信です'$old$,$new$  when q.id is null then '現在の取引のLINE発送依頼を作成待ちです'
  when (select count(*) from app.item_photos f where f.item_id=i.id
   and coalesce(f.photo_kind,'product')='product' and f.storage_path ~* '\.(jpe?g|png)$')<2
   then '全体写真・型番写真の準備待ちです'$new$);
 execute context_def;
end;
$migration$;
notify pgrst,'reload schema';
