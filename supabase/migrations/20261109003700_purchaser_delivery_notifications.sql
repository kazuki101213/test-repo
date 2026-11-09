-- Give purchasers the same delivery notification access for their own assignments.
CREATE OR REPLACE FUNCTION app.claim_delivery_push()
 RETURNS TABLE(delivery_id uuid, subscription_id uuid, endpoint text, p256dh text, auth text, base_url text, item_id uuid, lot_seq integer, kind text, eligible boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  update app.delivery_push_deliveries set state='failed'
    where state='sending' and attempts>=5 and next_attempt_at<=now();
  insert into app.delivery_push_deliveries(event_id,subscription_id)
    select e.id,s.id from app.delivery_push_events e join app.delivery_push_subscriptions s
      on s.staff_id=e.staff_id and s.app_kind='delivery' and s.enabled and s.created_at<=e.created_at
    where e.created_at>now()-interval '24 hours'
    on conflict do nothing;
  return query
  with ready as (
    select d.id from app.delivery_push_deliveries d where d.state in ('pending','sending')
      and d.next_attempt_at<=now() and d.attempts<5
    order by d.next_attempt_at limit 20 for update skip locked
  ), claimed as (
    update app.delivery_push_deliveries d set state='sending',attempts=d.attempts+1,next_attempt_at=now()+interval '5 minutes'
      from ready where d.id=ready.id returning d.*
  )
  select d.id,s.id,s.endpoint,s.p256dh,s.auth,s.base_url,i.id,i.lot_seq,e.kind,
    s.enabled and s.app_kind='delivery' and st.is_active and s.staff_id=e.staff_id and s.created_at<=e.created_at
    and e.created_at>now()-interval '24 hours'
    and (st.role='admin' or (i.deliverer_id=st.id and st.role in ('purchaser','deliverer')))
    and case e.kind
 when 'shipping' then i.status='取引中' and i.shipped_on is null and app.sales_channel_family(i.sales_channel) in ('メルカリ','ヤフオク','自己発送') and exists(select 1 from app.delivery_shipping_tasks t where t.item_id=i.id and t.created_at=e.event_at and t.resolved_at is null and not exists(select 1 from app.delivery_notice_completions c where c.staff_id=st.id and c.notice_id='shipping:'||t.id::text and c.item_id=i.id))
 when 'photo_return' then exists(select 1 from app.delivery_return_tasks t where t.item_id=i.id and t.kind=e.kind and t.created_at=e.event_at and t.resolved_at is null)
 when 'malfunction_return' then exists(select 1 from app.delivery_return_tasks t where t.item_id=i.id and t.kind=e.kind and t.created_at=e.event_at and t.resolved_at is null)
      when 'reply' then i.malfunction_reported_at<e.event_at and coalesce(r.reply_read_at,'-infinity')<e.event_at
      when 'photo' then p.approved_at=e.event_at and coalesce(r.photo_read_at,'-infinity')<e.event_at
      else i.shipped_on is null and i.sold_on is null end
  from claimed d join app.delivery_push_events e on e.id=d.event_id
    join app.delivery_push_subscriptions s on s.id=d.subscription_id
    join app.staff st on st.id=s.staff_id join app.items i on i.id=e.item_id
    left join app.item_notice_reads r on r.item_id=i.id and r.staff_id=st.id
    left join app.photo_reviews p on p.item_id=i.id;
end;
$function$;

CREATE OR REPLACE FUNCTION app.enqueue_delivery_push(p_item_id uuid, p_kind text, p_at timestamp with time zone, p_actor uuid)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  insert into app.delivery_push_events(item_id,staff_id,kind,event_at)
  select i.id,s.id,p_kind,p_at from app.items i join app.staff s
    on s.is_active and (s.role='admin' or (s.id=i.deliverer_id and s.role in ('purchaser','deliverer')))
  where i.id=p_item_id and s.id is distinct from p_actor
  on conflict(item_id,staff_id,kind,event_at) do nothing;
$function$;

CREATE OR REPLACE FUNCTION app.handle_delivery_line_event(p_event text, p_kind text, p_user text, p_hash text DEFAULT NULL::text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare target uuid;
begin
 perform pg_advisory_xact_lock(173511019);
 if p_user !~ '^U[0-9a-f]{32}$' or length(p_event)>128 or p_kind not in ('link','unfollow') then return false;end if;
 insert into app.delivery_line_webhooks(event_id) values(p_event) on conflict do nothing;
 if not found then return false;end if;
 delete from app.delivery_line_webhooks where created_at<now()-interval '7 days';
 delete from app.delivery_line_codes where expires_at<now();
 if p_kind='unfollow' then
  update app.delivery_line_links set blocked=true where line_user_id=p_user;
  update app.delivery_line_outbox o set state='cancelled' from app.delivery_line_links l
   where o.link_id=l.id and l.line_user_id=p_user and o.state in ('pending','sending');
  return false;
 end if;
 select c.staff_id into target from app.delivery_line_codes c join app.staff s on s.id=c.staff_id
  where c.code_hash=p_hash and c.expires_at>now() and s.is_active and s.role in ('admin','purchaser','deliverer') for update of c;
 if target is null or exists(select 1 from app.delivery_line_links where line_user_id=p_user and staff_id<>target) then return false;end if;
 -- A new generation cancels old pending messages, including retries to an old LINE.
 delete from app.delivery_line_links where staff_id=target;
 insert into app.delivery_line_links(staff_id,line_user_id) values(target,p_user);
 delete from app.delivery_line_codes where staff_id=target;
 perform app.ensure_line_shipping_requests(target); perform app.kick_delivery_line(); return true;
end $function$;

CREATE OR REPLACE FUNCTION app.issue_delivery_line_code(p_staff uuid, p_hash text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
 perform pg_advisory_xact_lock(hashtextextended(p_staff::text,17351));
 if not exists(select 1 from app.staff where id=p_staff and is_active and role in ('admin','purchaser','deliverer')) then raise exception 'Invalid staff';end if;
 if exists(select 1 from app.delivery_line_codes where staff_id=p_staff and created_at>now()-interval '1 minute') then raise exception 'Please wait one minute';end if;
 insert into app.delivery_line_codes(staff_id,code_hash,expires_at) values(p_staff,p_hash,now()+interval '10 minutes')
 on conflict(staff_id) do update set code_hash=excluded.code_hash,created_at=now(),expires_at=excluded.expires_at;
end $function$;
