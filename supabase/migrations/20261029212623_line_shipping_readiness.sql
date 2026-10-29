-- Prevent unconfigured LINE notifications from being deferred until after a sale.
-- These replacements preserve the current RPC authorization and delivery idempotency.
do $migration$
declare source text; patched text;
begin
 source:=pg_get_functiondef('app.line_shipping_context(uuid)'::regprocedure);
 patched:=replace(source,$old$reason:=case when p.model_photo_id is null$old$,$new$reason:=case when q.state='sent' then 'LINEへ送信済み'
  when q.state='failed' then 'LINE送信に失敗しました。設定を確認してください'
  when q.state='sending' then 'LINEへ送信中です'
  when p.model_photo_id is null$new$);
 if patched=source then raise exception 'LINE context status anchor changed';end if;
 patched:=replace(patched,$old$'overviewPhotoId',p.overview_photo_id,$old$,$new$'requiresPhotos',coalesce((select enabled from app.delivery_line_settings where singleton),false)
   and i.sales_channel in ('メルカリ','ヤフオク') and exists(select 1 from app.delivery_line_links l join app.staff s on s.id=l.staff_id and s.is_active where l.staff_id=i.deliverer_id and not l.blocked),
  'photosReady',exists(select 1 from app.item_photos f join app.item_photos m on m.id=p.model_photo_id and coalesce(m.photo_kind,'product')='product' where f.id=p.overview_photo_id and coalesce(f.photo_kind,'product')='product'),
  'overviewPhotoId',p.overview_photo_id,$new$);
 execute patched;
 source:=pg_get_functiondef('app.queue_seller_operation(uuid,text,jsonb,uuid)'::regprocedure);
 patched:=regexp_replace(source,$old$if[[:space:]]+i[.]status[[:space:]]*<>[[:space:]]*'商品登録前'[[:space:]]+then$old$,$new$
    IF coalesce((app.line_shipping_context(i.id)->>'requiresPhotos')::boolean,false)
      AND NOT coalesce((app.line_shipping_context(i.id)->>'photosReady')::boolean,false) THEN
      RAISE EXCEPTION '出品前にLINE発送依頼の全体写真と型番確認写真を保存してください';
    END IF;
    IF i.status <> '商品登録前' THEN$new$,'i');
 if patched=source then raise exception 'Listing readiness anchor changed';end if;
 execute patched;
 -- Include LINE preparation failures immediately, without waiting for the 24-hour reminder.
 source:=pg_get_functiondef('app.read_resource_snapshot(text,jsonb,jsonb)'::regprocedure);
 patched:=replace(source,$old$i.marketplace_url,t.created_at from app.delivery_shipping_tasks t$old$,$new$i.marketplace_url,t.created_at,case when lc.value->>'state' in ('pending','sending','failed') then lc.value->>'message' end as line_message from app.delivery_shipping_tasks t$new$);
 if patched=source then raise exception 'Shipping reminder projection anchor changed';end if;
 patched:=replace(patched,$old$join app.items i on i.id=t.item_id where t.resolved_at is null and t.created_at<=now()-interval '24 hours'$old$,$new$join app.items i on i.id=t.item_id left join lateral(select app.line_shipping_context(i.id) value) lc on true where t.resolved_at is null and (t.created_at<=now()-interval '24 hours' or lc.value->>'state' in ('pending','sending','failed'))$new$);
 if position('left join lateral(select app.line_shipping_context(i.id) value) lc' in patched)=0 then raise exception 'Shipping reminder filter anchor changed';end if;
 execute patched;
end $migration$;
