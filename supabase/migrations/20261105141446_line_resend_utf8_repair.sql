-- Keep user-facing messages and enum literals transport-safe even through legacy shell encodings.
create or replace function app.request_delivery_line_resend(p_item_id uuid)
returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 i app.items;
 task uuid;
 link uuid;
 outbox uuid;
 required_size text;
begin
 if auth.uid() is null or not exists(
  select 1 from app.staff s where s.id=app.current_staff_id() and s.is_active
 ) then raise exception U&'\30ED\30B0\30A4\30F3\304C\5FC5\8981\3067\3059' using errcode='42501'; end if;

 select * into i from app.items where id=p_item_id for update;
 if i.id is null or not (app.is_admin() or i.deliverer_id=app.current_staff_id()) then
  raise exception U&'\62C5\5F53\5546\54C1\3060\3051\518D\9001\3067\304D\307E\3059' using errcode='42501';
 end if;
 if i.status<>U&'\53D6\5F15\4E2D' or i.shipped_on is not null or i.sold_on is not null
  or i.seller_cancelled_at is not null or i.seller_trade_key is null then
  raise exception U&'\73FE\5728\306E\672A\767A\9001\53D6\5F15\3092\78BA\8A8D\3067\304D\307E\305B\3093';
 end if;
 if not coalesce((select enabled from app.delivery_line_settings where singleton),false) then
  raise exception U&'LINE\901A\77E5\304C\6709\52B9\3067\306F\3042\308A\307E\305B\3093';
 end if;
 if not exists(
  select 1 from app.delivery_line_preferences pref
  join app.item_photos front on front.id=pref.overview_photo_id and front.item_id=i.id
   and coalesce(front.photo_kind,'product')='product'
  join app.item_photos model on model.id=pref.model_photo_id and model.item_id=i.id
   and coalesce(model.photo_kind,'product')='product'
  where pref.item_id=i.id
 ) then raise exception U&'\5168\4F53\5199\771F\3068\578B\756A\5199\771F\3092\5148\306B\4FDD\5B58\3057\3066\304F\3060\3055\3044'; end if;

 select t.id into task from app.delivery_shipping_tasks t
 where t.item_id=i.id and t.resolved_at is null order by t.created_at desc limit 1;
 if task is null then raise exception U&'\672A\5B8C\4E86\306E\767A\9001\4F9D\983C\304C\3042\308A\307E\305B\3093'; end if;
 select l.id into link from app.delivery_line_links l
 join app.staff s on s.id=l.staff_id and s.is_active and not l.blocked
 where l.staff_id=i.deliverer_id order by l.linked_at desc limit 1;
 if link is null then raise exception U&'LINE\9023\643A\3092\78BA\8A8D\3057\3066\304F\3060\3055\3044'; end if;
 select o.id into outbox from app.delivery_line_outbox o
 where o.task_id=task and o.link_id=link and o.trade_key=i.seller_trade_key
 for update;
 if outbox is null then raise exception U&'\73FE\5728\306E\53D6\5F15\306B\5BFE\5FDC\3059\308BLINE\901A\77E5\304C\3042\308A\307E\305B\3093'; end if;
 if not exists(select 1 from app.delivery_line_outbox where id=outbox and state='sent') then
  raise exception U&'\518D\9001\3067\304D\308B\9001\4FE1\6E08\307F\901A\77E5\304C\3042\308A\307E\305B\3093';
 end if;

 required_size:=app.line_fixed_shipping_size(i.id);
 update app.delivery_line_outbox set state='pending',attempts=0,next_attempt_at=now(),
  first_attempt_at=null,sent_at=null,last_status=null,lease=null,message_payload=null,
  last_error=null,code_cleaned_at=null
 where id=outbox;
 perform app.kick_delivery_line();
 return jsonb_build_object('queued',true,'codeRequired',required_size is not null,'outboxId',outbox);
end $$;

revoke all on function app.request_delivery_line_resend(uuid) from public,anon;
grant execute on function app.request_delivery_line_resend(uuid) to authenticated;
notify pgrst,'reload schema';

do $$begin
 if position(chr(65533) in pg_get_functiondef('app.request_delivery_line_resend(uuid)'::regprocedure))>0 then
  raise exception 'LINE resend function contains replacement characters';
 end if;
end $$;
