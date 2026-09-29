create or replace function app.update_item_identity(p_item_id uuid,p_expected_updated_at timestamptz,p_field text,p_value text)
returns void language plpgsql security invoker set search_path = pg_catalog, app, public as $$
declare current_item app.items%rowtype; next_lot integer; next_sku text;
begin
 if app.current_role() not in ('admin','purchaser') then raise exception '編集権限がありません'; end if;
 select * into current_item from app.items where id=p_item_id for update;
 if not found then raise exception '在庫が見つかりません'; end if;
 if current_item.updated_at is distinct from p_expected_updated_at then raise exception '在庫が別の画面で変更されています'; end if;
 if p_field='lot_seq' then
   if p_value !~ '^[1-9][0-9]*$' then raise exception '通番号は1以上の整数で入力してください'; end if;
   next_lot:=p_value::integer;
   next_sku:=regexp_replace(current_item.sku,'^[0-9]+',next_lot::text);
   insert into app.lots(seq) values(next_lot) on conflict(seq) do nothing;
 elsif p_field='sku' then
   if p_value !~ '^[0-9]+[a-z]*-[A-Z]{2,4}-[0-9]{8}-[0-9]+$' then raise exception 'SKUの形式を確認してください'; end if;
   if substring(p_value from '^[0-9]+')::integer<>current_item.lot_seq then raise exception 'SKUの先頭と通番号を一致させてください'; end if;
   next_lot:=current_item.lot_seq;
   next_sku:=p_value;
 else
   raise exception '編集項目が不正です';
 end if;
 update app.items set lot_seq=next_lot,sku=next_sku where id=p_item_id;
end $$;
revoke all on function app.update_item_identity(uuid,timestamptz,text,text) from public;
grant execute on function app.update_item_identity(uuid,timestamptz,text,text) to authenticated;
comment on column app.items.sku is '出品者SKU。編集時は通番号と先頭番号を一致させる。';
