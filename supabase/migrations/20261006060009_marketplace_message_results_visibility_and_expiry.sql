drop policy if exists marketplace_message_outbox_read on app.marketplace_message_outbox;
create policy marketplace_message_outbox_read on app.marketplace_message_outbox for select to authenticated
using (exists(select 1 from app.items i where i.id=item_id and
  (app.is_admin() or app.current_role()='purchaser' or i.deliverer_id=app.current_staff_id())));
drop policy if exists marketplace_message_sync_read on app.marketplace_message_sync_requests;
create policy marketplace_message_sync_read on app.marketplace_message_sync_requests for select to authenticated
using (exists(select 1 from app.items i where i.id=item_id and
  (app.is_admin() or app.current_role()='purchaser' or i.deliverer_id=app.current_staff_id())));

create or replace function app.read_marketplace_messages(p_item_id uuid)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare first_sent timestamptz; packed_at timestamptz;
begin
 if not exists(select 1 from app.items i where i.id=p_item_id and (app.is_admin() or app.current_role()='purchaser' or i.deliverer_id=app.current_staff_id()))
 then raise exception 'この商品の取引メッセージを表示する権限がありません' using errcode='42501'; end if;
 select min(o.sent_at) into first_sent from app.marketplace_message_outbox o where o.item_id=p_item_id and o.status='sent' and o.sent_at is not null;
 select i.packed_completed_at into packed_at from app.items i where i.id=p_item_id;
 if packed_at is not null and packed_at<=now()-interval '7 days' then
  return jsonb_build_object('messages','[]'::jsonb,'outbox','[]'::jsonb,'first_app_sent_at',first_sent,'sync',null,'expired',true);
 end if;
 return jsonb_build_object(
  'messages',coalesce((select jsonb_agg(jsonb_build_object('id',m.id,'author',m.author,'author_role',m.author_role,'body',m.body,'sent_at',m.sent_at) order by m.sent_at,m.id)
   from app.marketplace_messages m where m.item_id=p_item_id and first_sent is not null and m.author_role='other' and m.sent_at>=first_sent),'[]'::jsonb),
  'outbox',coalesce((select jsonb_agg(jsonb_build_object('id',o.id,'body',o.body,'status',o.status,'requested_at',o.requested_at,'sent_at',o.sent_at,'result_note',o.result_note) order by o.requested_at)
   from app.marketplace_message_outbox o where o.item_id=p_item_id),'[]'::jsonb),
  'first_app_sent_at',first_sent,
  'sync',(select jsonb_build_object('id',r.id,'status',r.status,'requested_at',r.requested_at,'completed_at',r.completed_at,'result_note',r.result_note) from app.marketplace_message_sync_requests r where r.item_id=p_item_id order by r.requested_at desc limit 1),
  'expired',false);
end; $$;

create or replace function app.queue_marketplace_message(p_item_id uuid,p_body text)
returns uuid language plpgsql security invoker set search_path='' as $$
declare v_item app.items%rowtype; v_market text; v_outbox_id uuid;
begin
 if auth.uid() is null then raise exception 'ログインが必要です' using errcode='42501'; end if;
 if length(btrim(coalesce(p_body,''))) not between 1 and 2000 then raise exception 'メッセージは1〜2000文字で入力してください'; end if;
 select * into v_item from app.items where id=p_item_id;
 if not found or not (app.is_admin() or app.current_role()='purchaser' or v_item.deliverer_id=app.current_staff_id()) then
  raise exception 'この商品の取引メッセージを送信する権限がありません' using errcode='42501';
 end if;
 if v_item.packed_completed_at is not null and v_item.packed_completed_at<=now()-interval '7 days' then raise exception '梱包完了から7日を過ぎているため、メッセージを送信できません'; end if;
 if nullif(btrim(v_item.marketplace_item_id),'') is null then raise exception '取引IDが登録されていません'; end if;
 v_market:=v_item.marketplace::text;
 if v_market not in ('メルカリ','ヤフオク','ヤフフリ','PayPayフリマ','ラクマ') then raise exception 'この仕入先は取引メッセージ連携の対象外です'; end if;
 if exists(select 1 from app.marketplace_message_outbox where item_id=v_item.id and status in ('queued','sending')) then
  raise exception 'この商品の前の送信依頼が処理中です。結果を確認してから送信してください';
 end if;
 insert into app.marketplace_message_outbox(item_id,marketplace,marketplace_item_id,body,requested_by)
  values(v_item.id,v_market,v_item.marketplace_item_id,btrim(p_body),auth.uid()) returning id into strict v_outbox_id;
 return v_outbox_id;
end; $$;