-- 予備リモコンの利用記録を「2444→2472」のように、付けてきた商品の通番号を順につないで残す（2026-11-26 ユーザー指定）。
-- 間違えて付けたリモコンを予備に戻すときは、その商品を利用記録に入れず、元の予備をそのまま使える状態に戻す。

-- 利用記録の表記をそろえる：「リモコン」を外し、「 / 」「、」「,」「→」区切りを「→」でつなぐ。
create or replace function app.usage_chain_normalize(p_note text)
returns text language sql immutable set search_path = '' as $$
  select nullif(array_to_string(array(
    select btrim(part) from regexp_split_to_table(replace(coalesce(p_note,''),'リモコン',''), '\s*(→|/|／|,|，|、)\s*')
      with ordinality as t(part, n)
    where btrim(part) <> '' order by n), '→'), '');
$$;

-- 利用記録の最後の通番号（いちばん新しく付けていた商品）。
create or replace function app.usage_chain_last(p_note text)
returns text language sql immutable set search_path = '' as $$
  select (regexp_split_to_array(app.usage_chain_normalize(p_note), '→'))[
    array_length(regexp_split_to_array(app.usage_chain_normalize(p_note), '→'), 1)];
$$;

-- 利用記録の後ろに通番号を足す（同じ番号が続く場合は足さない）。
create or replace function app.usage_chain_append(p_note text, p_serial text)
returns text language sql immutable set search_path = '' as $$
  select case
    when nullif(btrim(coalesce(p_serial,'')),'') is null then app.usage_chain_normalize(p_note)
    when app.usage_chain_normalize(p_note) is null then btrim(p_serial)
    when lower(app.usage_chain_last(p_note)) = lower(btrim(p_serial)) then app.usage_chain_normalize(p_note)
    else app.usage_chain_normalize(p_note) || '→' || btrim(p_serial) end;
$$;

grant execute on function app.usage_chain_normalize(text), app.usage_chain_last(text), app.usage_chain_append(text,text)
  to authenticated, service_role;

-- 在庫のリモコン行を予備へ戻す。
--  通常：前に使っていた予備の利用記録に、今の通番号を足した新しい予備行を作る。
--  p_spare_input.mistaken=true：間違えて付けたもの。今の通番号は残さず、元の予備行を未使用に戻す。
create or replace function app.move_inventory_accessory_to_spares(p_item_id uuid, p_spare_input jsonb)
returns uuid
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_item app.items%rowtype;
  v_spare_id uuid;
  v_owner_id uuid;
  v_owner_name text;
  v_registered_serial text;
  v_history_item_id uuid;
  v_previous app.spare_accessories%rowtype;
  v_mistaken boolean := coalesce((p_spare_input->>'mistaken')::boolean, false);
begin
  if auth.uid() is null or app.current_role() not in ('admin','purchaser') then
    raise exception '予備一覧へ登録する権限がありません' using errcode='42501';
  end if;
  if p_spare_input is null or jsonb_typeof(p_spare_input) <> 'object' then
    raise exception 'リモコン情報が不正です' using errcode='22023';
  end if;

  select * into v_item from app.items where id=p_item_id for update;
  if not found then raise exception '在庫一覧のリモコン行が見つかりません' using errcode='P0002'; end if;
  if not v_item.is_accessory or v_item.title not ilike '%リモコン%' then
    raise exception '対象は付属品登録されたリモコン行ではありません' using errcode='22023';
  end if;
  if app.current_role() = 'purchaser' and v_item.purchaser_id is distinct from app.current_staff_id() then
    raise exception '担当外のリモコン行は移動できません' using errcode='42501';
  end if;
  if coalesce(p_spare_input->>'usage_note','') !~ '^[0-9]+[a-z]*$' then
    raise exception '利用記録に通番号を入力してください' using errcode='22023';
  end if;
  v_registered_serial := upper(p_spare_input->>'usage_note');
  if v_registered_serial is distinct from app.product_serial(v_item.sku,v_item.lot_seq) then
    raise exception '入力した通番号と在庫行の通番号が一致しません' using errcode='22023';
  end if;

  -- このリモコンが予備から来たものなら、その予備行（同じ商品ID）を前の利用記録として使う。
  select s.* into v_previous from app.spare_accessories s
  where s.used_for_item_id in (v_item.id, v_item.parent_item_id)
    and s.marketplace_item_id is not distinct from v_item.marketplace_item_id
  order by s.created_at desc, s.id desc limit 1;

  if v_mistaken and v_previous.id is not null then
    -- 間違えて付けたもの：元の予備行をそのまま未使用に戻す（今の商品は利用記録に入れない）。
    update app.spare_accessories set used_for_item_id=null, linked_item_id=null, updated_at=now()
    where id=v_previous.id;
    delete from app.items where id=v_item.id;  -- 発送依頼も一緒に消える（on delete cascade）
    return v_previous.id;
  end if;

  v_owner_id := coalesce(nullif(p_spare_input->>'owner_staff_id','')::uuid, v_item.deliverer_id, v_item.purchaser_id, app.current_staff_id());
  if app.current_role() = 'purchaser' and v_owner_id is distinct from app.current_staff_id() and v_owner_id is distinct from v_item.deliverer_id then
    raise exception '保管担当者には自分または商品の納品担当者を指定してください' using errcode='42501';
  end if;
  select name into v_owner_name from app.staff where id=v_owner_id;
  v_owner_name := coalesce(nullif(btrim(p_spare_input->>'owner_name'),''),v_owner_name);
  if nullif(btrim(p_spare_input->>'title'),'') is null then
    raise exception '品名を入力してください' using errcode='22023';
  end if;
  if coalesce(nullif(p_spare_input->>'cost_amount','')::bigint,v_item.cost_amount) < 0 then
    raise exception '仕入金額は0円以上で入力してください' using errcode='22023';
  end if;

  insert into app.spare_accessories (
    source_sku,owner_staff_id,owner_name,purchaser_id,purchased_at,title,manufacturer,model_no,asin,
    cost_amount,marketplace,marketplace_item_id,tracking_no,usage_note,purchase_account_id
  ) values (
    coalesce(nullif(p_spare_input->>'source_sku',''),v_item.sku),
    v_owner_id,v_owner_name,v_item.purchaser_id,
    coalesce(nullif(p_spare_input->>'purchased_at','')::date,v_item.purchased_at),
    btrim(p_spare_input->>'title'),
    nullif(btrim(p_spare_input->>'manufacturer'),''),
    nullif(btrim(p_spare_input->>'model_no'),''),
    nullif(btrim(p_spare_input->>'asin'),''),
    coalesce(nullif(p_spare_input->>'cost_amount','')::bigint,v_item.cost_amount),
    nullif(p_spare_input->>'marketplace',''),
    nullif(p_spare_input->>'marketplace_item_id',''),
    nullif(p_spare_input->>'tracking_no',''),
    -- 間違えて付けたもの（元の予備がない）は今の通番号を残さない。それ以外は前の利用記録に足す。
    case when v_mistaken then null else app.usage_chain_append(v_previous.usage_note, p_spare_input->>'usage_note') end,
    case when p_spare_input ? 'purchase_account_id' then p_spare_input->>'purchase_account_id'
      when v_item.marketplace::text=p_spare_input->>'marketplace' then v_item.purchase_account_id end
  ) returning id into v_spare_id;

  -- Keep the previous spare's usage history on the current body, as Yahoo preparation does.
  if exists (select 1 from app.spare_accessories where used_for_item_id=v_item.id) then
    select id into v_history_item_id from app.items
    where id=v_item.parent_item_id and not is_accessory;
    if v_history_item_id is null then
      raise exception '利用履歴の移行先となる本体が見つかりません。付属品の紐づけを確認してください。' using errcode='22023';
    end if;
    update app.spare_accessories set used_for_item_id=v_history_item_id, updated_at=now()
    where used_for_item_id=v_item.id;
  end if;
  delete from app.items where id=v_item.id;
  return v_spare_id;
end;
$function$;

-- 通番号で予備を探す処理は、利用記録の最後の通番号で比べる。
do $migration$
declare
  fn text;
  definition text;
begin
  foreach fn in array array['app.prepare_yahoo_auction_item(uuid)','app.apply_malfunction_reply()'] loop
    definition := pg_get_functiondef(fn::regprocedure);
    if position('lower(btrim(s.usage_note))' in definition) = 0 then
      raise exception 'usage_note comparison not found: %', fn;
    end if;
    execute replace(definition, 'lower(btrim(s.usage_note))', 'lower(app.usage_chain_last(s.usage_note))');
  end loop;
  definition := pg_get_functiondef('app.fill_spare_body_manufacturer()'::regprocedure);
  if position($a$serial:=lower(btrim(regexp_replace(coalesce(new.usage_note,''),'リモコン','','g')));$a$ in definition) = 0 then
    raise exception 'fill_spare_body_manufacturer serial line not found';
  end if;
  execute replace(definition, $a$serial:=lower(btrim(regexp_replace(coalesce(new.usage_note,''),'リモコン','','g')));$a$,
    $a$serial:=lower(coalesce(app.usage_chain_last(new.usage_note),''));$a$);
end $migration$;

-- ここから既存データの修正（本番のデータだけが対象。空のデータベースでは何もしない）。

-- 2534：間違えて付けた予備（商品ID s1246272416）を外し、2533と同梱で届いた g1228118421 に付け替える。
do $fix$
declare
  v_wrong_spare uuid;
  v_right_spare uuid;
  v_accessory uuid;
  v_body uuid;
begin
  select a.id, a.parent_item_id into v_accessory, v_body from app.items a
  where a.is_accessory and a.marketplace_item_id='s1246272416' and app.product_serial(a.sku,a.lot_seq)='2534';
  select id into v_right_spare from app.spare_accessories where marketplace_item_id='g1228118421' and used_for_item_id is null;
  select id into v_wrong_spare from app.spare_accessories where marketplace_item_id='s1246272416' and used_for_item_id=v_body;
  if v_accessory is null or v_right_spare is null or v_wrong_spare is null then return; end if;

  update app.spare_shipping_tasks set spare_id=v_right_spare, marketplace_item_id='g1228118421', usage_note=null
  where spare_id=v_wrong_spare and accessory_item_id=v_accessory;
  update app.items set marketplace_item_id='g1228118421', cost_amount=1793, purchased_at='2026-11-23',
    identity_checked_on='2026-11-23', memo='2533、2534同梱。', updated_at=now()
  where id=v_accessory;
  update app.spare_accessories set used_for_item_id=v_body, updated_at=now() where id=v_right_spare;
  -- s1246272416 は 2444→2472→2501 と使われ、2501で動作不良のため長部さんの元へ戻ったもの（ユーザー確認）。
  -- 2534 は間違えて付けたので利用記録に入れない。2501から戻したときの予備行を未使用に戻す。
  update app.spare_accessories set used_for_item_id=null, linked_item_id=null, updated_at=now() where id=v_wrong_spare;
end $fix$;

-- 11/25に別のリモコンへ書いてしまった利用記録を元に戻す（2501・2414・2460の今のリモコンは新しく買ったもので、予備ではない）。
update app.items a set memo='2501、2506同梱。', updated_at=now()
where a.is_accessory and a.marketplace_item_id='c1246402312' and a.memo like '%利用記録:2472%';
update app.items a set memo=null, updated_at=now()
where a.is_accessory and (
  (a.marketplace_item_id='u1251766190' and btrim(a.memo)='利用記録:2398') or
  (a.marketplace_item_id='m42079366436' and btrim(a.memo)='利用記録:2379'));

-- 予備の利用記録を、付けてきた順につないだ形に直す（古い行から順に、前の予備行の利用記録を引き継ぐ）。
do $chain$
declare
  r record;
  v_note text;
  v_prev text;
begin
  for r in select s.id, s.usage_note, s.marketplace_item_id, s.created_at from app.spare_accessories s
    where nullif(btrim(s.usage_note),'') is not null order by s.created_at, s.id loop
    v_note := app.usage_chain_normalize(r.usage_note);
    v_prev := null;
    if r.marketplace_item_id is not null then
      select p.usage_note into v_prev from app.spare_accessories p join app.items u on u.id=p.used_for_item_id
      where p.id<>r.id and p.marketplace_item_id=r.marketplace_item_id and p.created_at<r.created_at
        and lower(app.product_serial(u.sku,u.lot_seq))=lower(app.usage_chain_last(v_note))
      order by p.created_at desc, p.id desc limit 1;
    end if;
    if v_prev is not null then v_note := app.usage_chain_append(v_prev, app.usage_chain_last(v_note)); end if;
    if v_note is distinct from r.usage_note then
      update app.spare_accessories set usage_note=v_note where id=r.id;
    end if;
  end loop;
end $chain$;

-- 付属品のコメントの「利用記録:〜」も、その付属品に使った予備（同じ商品ID）の利用記録にそろえる。
with matched as (
  select a.id, regexp_replace(a.memo, '利用記録:[^\n]*', '利用記録:'||(
    select sp.usage_note from app.spare_accessories sp
    where sp.used_for_item_id in (a.id, a.parent_item_id)
      and sp.marketplace_item_id is not distinct from a.marketplace_item_id
      and nullif(btrim(sp.usage_note),'') is not null
    order by sp.created_at desc, sp.id desc limit 1)) memo
  from app.items a
  where a.is_accessory and a.memo like '%利用記録:%'
)
update app.items a set memo=m.memo, updated_at=now()
from matched m
where a.id=m.id and m.memo is not null and m.memo is distinct from a.memo;

-- 発送依頼に写してある利用記録もそろえる。
update app.spare_shipping_tasks t set usage_note=s.usage_note
from app.spare_accessories s where s.id=t.spare_id and t.usage_note is distinct from s.usage_note;

notify pgrst, 'reload schema';
