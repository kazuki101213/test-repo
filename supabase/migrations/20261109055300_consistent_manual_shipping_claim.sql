-- Apply the same shipping rules when a request is queued and when a worker claims it.
create or replace function app.seller_shipping_validation_error(
  p_item_id uuid, p_channel text, p_kind text, p_payload jsonb
) returns text
language plpgsql stable
set search_path = pg_catalog, app
as $function$
declare
  catalog_size text := app.line_fixed_shipping_size(p_item_id);
  shipment_size text := coalesce(p_payload->>'size', '');
  shipping_method text := p_payload->>'shippingMethod';
  dropoff text := coalesce(p_payload->>'dropoff', '');
begin
  if catalog_size is not null then
    if shipment_size <> catalog_size then
      return '商品リストと配送サイズが一致しません。設定を確認してください';
    end if;
    return null;
  end if;

  if p_payload ? 'automatic_line' then
    return '商品リストの配送サイズが未設定です。サイズを保存してからコードを発行してください';
  end if;

  if (
    case shipping_method
      when 'らくらくメルカリ便' then p_channel = 'メルカリ'
        and shipment_size in ('100', '140', '宅急便コンパクト', 'ネコポス') and dropoff in ('セブンイレブン', 'ヤマト営業所')
      when 'おてがる配送（ヤマト運輸）' then p_channel = 'ヤフオク'
        and shipment_size in ('100', '140', '宅急便コンパクト') and dropoff in ('セブンイレブン', 'ヤマト営業所')
      when 'ゆうゆうメルカリ便' then p_channel = 'メルカリ'
        and shipment_size in ('100', '140', 'ゆうパケットプラス', 'ゆうパケットポストmini', 'ゆうパケット') and dropoff in ('ローソン', '郵便局')
      when 'おてがる配送（日本郵便）' then p_channel = 'ヤフオク'
        and shipment_size in ('100', '140', 'ゆうパケットプラス', 'ゆうパケットポストmini', 'ゆうパケット') and dropoff in ('ローソン', '郵便局')
      else false
    end
  ) is not true or ((p_kind = 'register_package') <> (shipment_size = 'ゆうパケットポストmini')) then
    return '配送方法に対応する配送サイズと発送場所を選択してください';
  end if;

  return null;
end;
$function$;

revoke all on function app.seller_shipping_validation_error(uuid, text, text, jsonb) from public, anon, authenticated;

do $migration$
declare
  definition text := pg_get_functiondef('app.queue_seller_operation(uuid,text,jsonb,uuid)'::regprocedure);
  gate_start integer := strpos(definition, E'  IF p_kind IN (''shipping_code'', ''register_package'') THEN\n');
  gate_end integer := strpos(definition, E'  IF p_kind = ''listing'' THEN\n');
  shipping_gate text := $gate$  IF p_kind IN ('shipping_code', 'register_package') THEN
    DECLARE
      validation_error text := app.seller_shipping_validation_error(i.id, i.sales_channel::text, p_kind, p_payload);
    BEGIN
      IF validation_error IS NOT NULL THEN
        RAISE EXCEPTION USING message = validation_error, errcode = '22023';
      END IF;
    END;
  END IF;
$gate$;
begin
  if strpos(definition, shipping_gate) > 0 then return; end if;
  if gate_start = 0 or gate_end <= gate_start
    or strpos(substr(definition, gate_start, gate_end - gate_start), 'ELSIF p_payload ? ''automatic_line''') = 0 then
    raise exception 'Seller operation shipping validation has changed';
  end if;
  execute substr(definition, 1, gate_start - 1) || shipping_gate || substr(definition, gate_end);
end;
$migration$;

create or replace function app.extension_claim_seller_operation(p_id uuid, p_account_id text)
returns boolean
language plpgsql security definer
set search_path = pg_catalog, app
as $function$
begin
  if auth.uid() is null or not app.is_admin()
    or not exists(select 1 from app.staff where id = app.current_staff_id() and is_active) then
    raise exception '権限がありません' using errcode = '42501';
  end if;

  update app.seller_operations o
  set status = 'running', claimed_at = clock_timestamp()
  where o.id = p_id and o.status = 'queued' and o.account_id = p_account_id
    and exists (
      select 1 from app.items i
      where i.id = o.item_id and i.status = o.expected_status and i.updated_at = o.expected_updated_at
        and i.sold_on is null and i.sales_channel = o.channel
        and (o.kind <> 'listing' or app.listing_photos_approved(i.id))
        and (o.kind not in ('shipping_code', 'register_package')
          or app.seller_shipping_validation_error(i.id, i.sales_channel::text, o.kind, o.payload) is null)
        and (o.kind = 'listing' or exists (
          select 1 from app.seller_listings l
          where l.item_id = i.id and l.active and l.trade_key = o.payload->>'trade_key'
        ))
    );
  if found then return true; end if;

  update app.seller_operations
  set status = 'failed', finished_at = clock_timestamp(),
    result = jsonb_build_object('note', '商品または取引が変更されたため実行しませんでした')
  where id = p_id and account_id = p_account_id and status = 'queued';
  return false;
end;
$function$;
