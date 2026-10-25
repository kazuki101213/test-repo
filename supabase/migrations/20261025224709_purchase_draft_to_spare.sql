alter table app.marketplace_purchase_drafts add column registered_spare_id uuid references app.spare_accessories(id) on delete set null;

create function app.register_purchase_draft_spare(p_draft_id uuid,p_input jsonb)
returns uuid language plpgsql security invoker set search_path='' as $$
declare d app.marketplace_purchase_drafts%rowtype; spare_id uuid; owner_id uuid; owner_label text; item_title text; price bigint; purchase_date date; maker text;
begin
  if auth.uid() is null or not app.is_admin() then raise exception '管理者のみ登録できます' using errcode='42501'; end if;
  select * into d from app.marketplace_purchase_drafts where id=p_draft_id for update;
  if not found then raise exception '仕入れリストの商品が見つかりません' using errcode='22023'; end if;
  if d.state='registered' and d.registered_spare_id is not null then return d.registered_spare_id; end if;
  if d.state<>'draft' or d.registered_item_id is not null then raise exception 'この商品は既に処理されています。一覧を更新してください' using errcode='22023'; end if;
  if p_input is null or jsonb_typeof(p_input)<>'object' then raise exception '登録情報を確認してください' using errcode='22023'; end if;
  owner_id:=nullif(p_input->>'owner_staff_id','')::uuid;
  select name into owner_label from app.staff where id=owner_id and is_active;
  if owner_label is null then raise exception '保管担当者を選択してください' using errcode='22023'; end if;
  item_title:=nullif(btrim(p_input->>'title'),'');
  if item_title is null or length(item_title)>500 then raise exception '品名を入力してください' using errcode='22023'; end if;
  if coalesce(p_input->>'cost_amount','') !~ '^[0-9]{1,10}$' then raise exception '仕入金額は0円以上の整数にしてください' using errcode='22023'; end if;
  price:=(p_input->>'cost_amount')::bigint;
  if coalesce(p_input->>'purchased_at','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then raise exception '購入日を入力してください' using errcode='22023'; end if;
  purchase_date:=(p_input->>'purchased_at')::date;
  maker:=nullif(btrim(p_input->>'manufacturer'),'');
  if length(maker)>200 then raise exception 'メーカーは200文字以内にしてください' using errcode='22023'; end if;
  if exists(select 1 from app.spare_accessories s where s.marketplace=d.marketplace and s.marketplace_item_id=d.marketplace_item_id)
    or exists(select 1 from app.items i where i.source_purchase_draft_id=d.id or (i.marketplace::text=d.marketplace and i.marketplace_item_id=d.marketplace_item_id))
    then raise exception 'この商品は既に在庫または予備に登録されています。登録先を確認してください' using errcode='22023'; end if;
  insert into app.spare_accessories(owner_staff_id,owner_name,purchased_at,title,manufacturer,model_no,asin,cost_amount,marketplace,marketplace_item_id,usage_note)
  values(owner_id,owner_label,purchase_date,item_title,maker,d.model_no,d.asin,price,d.marketplace,d.marketplace_item_id,null) returning id into spare_id;
  update app.marketplace_purchase_drafts set state='registered',registered_spare_id=spare_id where id=d.id;
  return spare_id;
end $$;
revoke all on function app.register_purchase_draft_spare(uuid,jsonb) from public,anon;
grant execute on function app.register_purchase_draft_spare(uuid,jsonb) to authenticated;
