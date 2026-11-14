-- A LINE message may have been sent without a code before the code was issued.
-- Keep the issued-code evidence even when the original message is already sent.
do $migration$
declare
 definition text := pg_get_functiondef('app.record_marketplace_code_shipping_date()'::regprocedure);
 old_guard text := $old$and o.state in ('pending', 'sending', 'failed');$old$;
begin
 if strpos(definition,old_guard)=0 then raise exception 'Code issuance LINE state guard changed';end if;
 execute replace(definition,old_guard,$new$and o.state in ('pending', 'sending', 'failed', 'sent');$new$);
end $migration$;

create or replace function app.line_shipping_eligible(p_id uuid)
returns boolean language sql stable set search_path='' as $$
 select coalesce((
  select not l.blocked and s.is_active and s.id=i.deliverer_id
   and o.state<>'cancelled' and i.status='取引中'
   and i.sold_on is null and i.seller_cancelled_at is null
   and (
    (t.resolved_at is null and i.shipped_on is null)
    or exists (
     select 1 from app.seller_operations issue
     join app.seller_listings listing on listing.item_id=i.id and listing.active
      and listing.channel=issue.channel and listing.account_id=issue.account_id and listing.trade_key=o.trade_key
     where issue.id=o.code_issue_operation_id and issue.item_id=i.id
      and issue.kind in ('shipping_code','register_package') and issue.status='succeeded'
      and issue.channel=i.sales_channel and issue.payload->>'trade_key'=i.seller_trade_key
      and issue.created_at>=t.created_at and (issue.finished_at at time zone 'Asia/Tokyo')::date=i.shipped_on
      and not exists (
       select 1 from app.seller_operations notice
       where notice.item_id=i.id and notice.account_id=listing.account_id and notice.channel=listing.channel
        and notice.payload->>'trade_key'=listing.trade_key and notice.kind='ship_notice'
        and notice.status='succeeded' and notice.result->>'notified'='true'
      )
    )
   )
   and (
    app.sales_channel_family(i.sales_channel)='自己発送'
    or (
     app.sales_channel_family(i.sales_channel) in ('メルカリ','ヤフオク')
     and o.trade_key=i.seller_trade_key and exists (
      select 1 from app.seller_listings sl where sl.item_id=i.id and sl.active
       and sl.trade_key=o.trade_key and sl.channel=i.sales_channel
     )
    )
   )
  from app.delivery_line_outbox o join app.delivery_line_links l on l.id=o.link_id
  join app.staff s on s.id=l.staff_id join app.delivery_shipping_tasks t on t.id=o.task_id
  join app.items i on i.id=t.item_id where o.id=p_id
 ),false);
$$;

-- Attach the verified code on resend even for a product with no catalog size.
do $migration$
declare
 definition text := pg_get_functiondef('app.line_shipping_media(uuid)'::regprocedure);
 old_guard text := 'where required.needs_code and listing.item_id is not null';
begin
 if strpos(definition,old_guard)=0 then raise exception 'LINE media code selection changed';end if;
 execute replace(definition,old_guard,$new$where listing.item_id is not null
   and (case when i.shipped_on is not null then op.id=o.code_issue_operation_id else required.needs_code end)$new$);
end $migration$;

create or replace function app.request_delivery_line_resend(p_item_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
 i app.items;
 outbox app.delivery_line_outbox;
 issued_code uuid;
 media jsonb;
begin
 if auth.uid() is null or not exists(
  select 1 from app.staff s where s.id=app.current_staff_id() and s.is_active
 ) then raise exception 'ログインが必要です' using errcode='42501';end if;
 select * into i from app.items where id=p_item_id for update;
 if i.id is null or not (app.is_admin() or i.deliverer_id=app.current_staff_id()) then
  raise exception '担当商品のみ再送できます' using errcode='42501';
 end if;
 if i.status<>'取引中' or i.sold_on is not null or i.seller_cancelled_at is not null or i.seller_trade_key is null then
  raise exception '現在の未発送取引を確認できません';
 end if;
 if not coalesce((select enabled from app.delivery_line_settings where singleton),false) then
  raise exception 'LINE通知が有効ではありません';
 end if;

 select o.* into outbox
 from app.delivery_shipping_tasks t
 join app.delivery_line_outbox o on o.task_id=t.id and o.trade_key=i.seller_trade_key
 join app.delivery_line_links l on l.id=o.link_id and l.staff_id=i.deliverer_id and not l.blocked
 where t.item_id=i.id and (t.resolved_at is null or i.shipped_on is not null)
 order by t.created_at desc,o.created_at desc limit 1 for update of o;
 if i.shipped_on is not null and outbox.id is null then raise exception '現在の未発送取引を確認できません';end if;
 if outbox.id is null then raise exception '現在の取引に対応するLINE通知がありません';end if;
 if outbox.state<>'sent' and i.shipped_on is null then raise exception '再送できる送信済み通知がありません';end if;

 if i.shipped_on is not null then
  -- Recover historical rows that were sent before the code was issued. Use the
  -- original task's close time to distinguish issuance from a manual date.
  select op.id into issued_code
  from app.seller_operations op
  join app.seller_listings l on l.item_id=i.id and l.active and l.trade_key=i.seller_trade_key
   and l.channel=i.sales_channel and l.channel=op.channel and l.account_id=op.account_id
  join app.delivery_shipping_tasks t on t.id=outbox.task_id
  where op.item_id=i.id and op.payload->>'trade_key'=i.seller_trade_key
   and op.kind='shipping_code' and op.status='succeeded' and nullif(op.result->>'qr_code','') is not null
   and op.created_at>=t.created_at and (op.finished_at at time zone 'Asia/Tokyo')::date=i.shipped_on
   and (op.id=outbox.code_issue_operation_id or (
    outbox.code_issue_operation_id is null and t.resolved_at>=op.finished_at
    and t.resolved_at<=op.finished_at+interval '10 seconds'
   ))
  order by op.finished_at desc,op.id desc limit 1;
  if issued_code is null then raise exception '現在の未発送取引を確認できません';end if;
  update app.delivery_line_outbox set code_issue_operation_id=issued_code where id=outbox.id
   and code_issue_operation_id is distinct from issued_code;
 end if;
 if not app.line_shipping_eligible(outbox.id) then raise exception '現在の未発送取引を確認できません';end if;
 if outbox.state<>'sent' then raise exception '再送できる送信済み通知がありません';end if;
 media:=app.line_shipping_media(outbox.id);
 if issued_code is not null and media->>'codeOperationId' is distinct from issued_code::text then
  raise exception '現在の配送設定に対応する発送コードを確認できません';
 end if;

 perform app.enqueue_line_photo_selection(i.id);
 update app.delivery_line_outbox set state='pending',attempts=0,next_attempt_at=now(),
  first_attempt_at=null,sent_at=null,last_status=null,lease=null,message_payload=null,
  last_error=null,code_cleaned_at=null,line_retry_key=gen_random_uuid()
 where id=outbox.id;
 perform app.kick_delivery_line();
 return jsonb_build_object('queued',true,'codeRequired',
  coalesce(media->>'codeOperationId' is not null or (media is null and app.line_fixed_shipping_size(i.id) is not null),false),
  'outboxId',outbox.id);
end;
$$;

notify pgrst,'reload schema';
