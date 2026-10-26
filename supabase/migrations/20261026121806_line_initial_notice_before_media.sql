-- Existing requests retain their delivery policy. New requests may send a
-- separate, idempotent initial notice while photos/code are being prepared.
alter table app.delivery_line_outbox
 add column allow_initial_notice boolean not null default false,
 add column delivery_phase text not null default 'media' check(delivery_phase in ('initial','media')),
 add column initial_retry_key uuid not null default gen_random_uuid(),
 add column initial_sent_at timestamptz,
 add column initial_message_payload jsonb,
 add column initial_last_status integer;
alter table app.delivery_line_outbox alter column allow_initial_notice set default true;

create function app.line_initial_notice_payload(p_id uuid) returns jsonb
language sql stable security invoker set search_path='' as $$
 select jsonb_build_object('itemId',i.id,'serial',app.product_serial(i.sku,i.lot_seq),'sku',i.sku,
  'title',case when i.title ~ '^X[0-9A-Z]{9}$' then coalesce(p.model_no,i.title) else coalesce(i.title,p.model_no,'') end,
  'supplierUrl',null,'images','[]'::jsonb,'initialNotice',true,'deliveryRetryKey',o.initial_retry_key)
 from app.delivery_line_outbox o join app.delivery_shipping_tasks t on t.id=o.task_id join app.items i on i.id=t.item_id
 left join app.products p on p.id=i.product_id
 where o.id=p_id and o.allow_initial_notice and o.initial_sent_at is null and app.line_shipping_eligible(o.id);
$$;
revoke all on function app.line_initial_notice_payload(uuid) from public,anon,authenticated;
grant execute on function app.line_initial_notice_payload(uuid) to service_role;

create or replace function app.claim_delivery_line() returns table(id uuid,lease uuid,recipient text,payload jsonb,eligible boolean)
language plpgsql security definer set search_path='' as $$
begin
 if not coalesce((select enabled from app.delivery_line_settings where singleton),false) then return;end if;
 update app.delivery_line_outbox o set state='failed',last_error='LINE通知を完了できませんでした。管理者へ確認してください'
 where o.state in ('pending','sending') and o.next_attempt_at<=now() and (o.attempts>=5 or o.first_attempt_at<now()-interval '23 hours');
 return query with ready as (
  select o.id from app.delivery_line_outbox o where o.state in ('pending','sending') and o.next_attempt_at<=now() and o.attempts<5
   and coalesce(o.first_attempt_at,now())>now()-interval '23 hours' and app.line_shipping_eligible(o.id)
   and (o.delivery_phase='initial' or app.line_shipping_media(o.id) is not null
    or o.allow_initial_notice and o.initial_sent_at is null and o.attempts=0)
  order by o.next_attempt_at limit 2 for update skip locked
 ),claimed as (
  update app.delivery_line_outbox o set state='sending',attempts=o.attempts+1,first_attempt_at=coalesce(o.first_attempt_at,now()),
   next_attempt_at=now()+interval '5 minutes',lease=gen_random_uuid(),
   delivery_phase=case when o.delivery_phase='initial' then 'initial'
    when o.message_payload is null and app.line_shipping_media(o.id) is null then 'initial' else 'media' end
  from ready r where o.id=r.id returning o.*
 ) select o.id,o.lease,l.line_user_id,coalesce(o.message_payload,
  case when o.delivery_phase='initial' then app.line_initial_notice_payload(o.id)
   else jsonb_build_object('media',app.line_shipping_media(o.id),'imageFollowup',o.initial_sent_at is not null) end),app.line_shipping_eligible(o.id)
 from claimed o join app.delivery_line_links l on l.id=o.link_id;
 perform app.arm_delivery_line_retry();
end $$;

create or replace function app.line_shipping_context(p_item_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare i app.items;p app.delivery_line_preferences;q app.delivery_line_outbox;reason text;
begin
 select * into i from app.items where id=p_item_id;
 if auth.uid() is null or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active)
 or i.id is null or not (app.is_admin() or i.deliverer_id=app.current_staff_id()) then raise exception '担当商品のみ確認できます' using errcode='42501';end if;
 select * into p from app.delivery_line_preferences where item_id=i.id;
 select o.* into q from app.delivery_line_outbox o join app.delivery_shipping_tasks t on t.id=o.task_id
 where t.item_id=i.id order by o.created_at desc limit 1;
 reason:=case when q.state='sent' then 'LINEへ送信済み'
  when q.state='cancelled' then 'この発送依頼は終了しました'
  when q.last_error is not null then q.last_error
  when q.initial_sent_at is not null then 'LINE本文は送信済みです。画像は準備後に自動送信します。'
  when p.model_photo_id is null or p.overview_photo_id is null then '通知写真を指定してください'
  when q.id is null then '次の新しい発送依頼から自動通知します'
  when app.line_shipping_media(q.id) is null then '配送設定・発送コードの確認待ちです'
  else 'LINE通知の準備中です' end;
 return jsonb_build_object('photoOrder',app.line_listing_photo_order(i.id),'overviewPhotoId',p.overview_photo_id,'modelPhotoId',p.model_photo_id,'shipping',coalesce(p.shipping,'{}'),
  'state',q.state,'initialSentAt',q.initial_sent_at,'message',reason,'enabled',coalesce((select enabled from app.delivery_line_settings where singleton),false));
end $$;

create or replace function app.prepare_delivery_line_message(p_id uuid,p_lease uuid,p_messages jsonb) returns boolean
language plpgsql security definer set search_path='' as $$
begin
 if not app.line_shipping_eligible(p_id) or jsonb_typeof(p_messages) is distinct from 'object' or octet_length(p_messages::text)>20000 then return false;end if;
 update app.delivery_line_outbox o set message_payload=coalesce(o.message_payload,p_messages)
 where o.id=p_id and o.lease=p_lease and o.state='sending'
  and (o.delivery_phase='media' and not coalesce((p_messages->>'initialNotice')::boolean,false)
   or o.delivery_phase='initial' and o.allow_initial_notice and o.initial_sent_at is null
    and p_messages->>'initialNotice'='true' and p_messages->>'deliveryRetryKey'=o.initial_retry_key::text);
 return found;
end $$;

create or replace function app.kick_delivery_line() returns bigint
language plpgsql security definer set search_path='' as $$
declare dispatch_token text;project_url text;request_id bigint;
begin
 if not coalesce((select enabled from app.delivery_line_settings where singleton),false) or not exists(
  select 1 from app.delivery_line_outbox o where state in ('pending','sending') and next_attempt_at<=now()
   and attempts<5 and app.line_shipping_eligible(o.id) and (o.delivery_phase='initial' or app.line_shipping_media(o.id) is not null
    or o.allow_initial_notice and o.initial_sent_at is null and o.attempts=0)
 ) then return null;end if;
 select decrypted_secret into dispatch_token from vault.decrypted_secrets where name='delivery_push_dispatch_token';
 select decrypted_secret into project_url from vault.decrypted_secrets where name='delivery_push_project_url';
 if dispatch_token is null or project_url is null then return null;end if;
 select net.http_post(url:=project_url||'/functions/v1/delivery-line',headers:=jsonb_build_object('Content-Type','application/json','x-delivery-dispatch',dispatch_token),
  body:='{"action":"dispatch"}'::jsonb,timeout_milliseconds:=50000) into request_id;return request_id;
end $$;

create or replace function app.finish_delivery_line(p_id uuid,p_lease uuid,p_state text,p_status integer) returns void
language plpgsql security definer set search_path='' as $$
begin
 if p_state='sent' then
  update app.delivery_line_outbox set initial_sent_at=now(),initial_last_status=p_status,initial_message_payload=message_payload,
   delivery_phase='media',state='pending',attempts=0,first_attempt_at=null,next_attempt_at=now(),lease=null,
   message_payload=null,last_error=null,last_status=null
  where id=p_id and lease=p_lease and state='sending' and delivery_phase='initial';
  if found then perform app.arm_delivery_line_retry();perform app.kick_delivery_line();return;end if;
 end if;
 update app.delivery_line_outbox set state=case when p_state='pending' and attempts>=5 then 'failed' else p_state end,
  last_status=p_status,sent_at=case when p_state='sent' then now() else sent_at end,next_attempt_at=now()+interval '5 minutes',
  last_error=case when p_state='failed' or p_state='pending' and attempts>=5 then 'LINEへの通知に失敗しました。管理者へ確認してください' else last_error end
 where id=p_id and lease=p_lease and state='sending' and p_state in ('pending','sent','cancelled','failed');
 if found then perform app.arm_delivery_line_retry();end if;
end $$;

create or replace function app.retry_delivery_line() returns bigint
language plpgsql security definer set search_path='' as $$
begin
 perform cron.unschedule(jobid) from cron.job where jobname='delivery-line-retry';
 update app.delivery_line_outbox set state='failed',last_error='LINE通知を完了できませんでした。管理者へ確認してください'
 where state in ('pending','sending') and next_attempt_at<=now() and (attempts>=5 or first_attempt_at<now()-interval '23 hours');
 update app.delivery_line_outbox o set state='cancelled' where state in ('pending','sending') and attempts>0
  and (not app.line_shipping_eligible(o.id) or o.delivery_phase<>'initial' and app.line_shipping_media(o.id) is null);
 perform app.arm_delivery_line_retry();return app.kick_delivery_line();
end $$;
