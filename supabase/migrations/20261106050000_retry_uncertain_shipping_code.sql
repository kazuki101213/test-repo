create function app.retry_uncertain_shipping_code(p_item_id uuid, p_payload jsonb, p_request_id uuid)
returns uuid language plpgsql security definer set search_path=pg_catalog,app as $$
declare i app.items; prior app.seller_operations; staff_id uuid:=app.current_staff_id();
begin
 if auth.uid() is null or staff_id is null or not exists(select 1 from app.staff where id=staff_id and is_active) then raise exception 'ログインが必要です' using errcode='42501'; end if;
 select * into i from app.items where id=p_item_id for update;
 if i.id is null or not coalesce(app.is_admin() or i.deliverer_id=staff_id,false) then raise exception '納品担当者または管理者のみ操作できます' using errcode='42501'; end if;
 select * into prior from app.seller_operations where item_id=i.id and status='uncertain' for update;
 if prior.id is null or prior.kind<>'shipping_code' or prior.payload->>'trade_key' is distinct from p_payload->>'trade_key' then raise exception '再確認する発送コードの取引が一致しません'; end if;
 update app.seller_operations set status='failed',result=result||jsonb_build_object('retry_requested_at',clock_timestamp(),'retry_requested_by',staff_id) where id=prior.id;
 return app.queue_seller_operation(p_item_id,'shipping_code',p_payload,p_request_id);
end $$;
revoke all on function app.retry_uncertain_shipping_code(uuid,jsonb,uuid) from public,anon;
grant execute on function app.retry_uncertain_shipping_code(uuid,jsonb,uuid) to authenticated;
