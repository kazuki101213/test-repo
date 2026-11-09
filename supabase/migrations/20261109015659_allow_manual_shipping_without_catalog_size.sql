-- Preserve the catalog requirement for automatic LINE, while allowing a
-- validated per-shipment choice from the manual shipping screen.
do $migration$
declare
  definition text := pg_get_functiondef('app.queue_seller_operation(uuid,text,jsonb,uuid)'::regprocedure);
  listing_anchor text := '(?in)^[[:blank:]]*if p_kind[[:blank:]]*=[[:blank:]]*''listing''[[:blank:]]+then';
  old_gate text := $old$  -- The catalog is authoritative for both manual and automatic code requests.
  IF p_kind IN ('shipping_code', 'register_package') THEN
    IF app.line_fixed_shipping_size(i.id) IS NULL THEN
      RAISE EXCEPTION '商品リストの配送サイズが未設定です。サイズを保存してからコードを発行してください' USING errcode = '22023';
    END IF;
    IF p_payload->>'size' IS DISTINCT FROM app.line_fixed_shipping_size(i.id) THEN
      RAISE EXCEPTION '商品リストと配送サイズが一致しません。設定を確認してください' USING errcode = '22023';
    END IF;
  END IF;
$old$;
  shipping_gate text := $gate$  IF p_kind IN ('shipping_code', 'register_package') THEN
    DECLARE
      catalog_size text := app.line_fixed_shipping_size(i.id);
      shipment_size text := coalesce(p_payload->>'size', '');
      shipping_method text := p_payload->>'shippingMethod';
      dropoff text := coalesce(p_payload->>'dropoff', '');
    BEGIN
      IF catalog_size IS NOT NULL THEN
        IF shipment_size <> catalog_size THEN
          RAISE EXCEPTION '商品リストと配送サイズが一致しません。設定を確認してください' USING errcode = '22023';
        END IF;
      ELSIF p_payload ? 'automatic_line' THEN
        RAISE EXCEPTION '商品リストの配送サイズが未設定です。サイズを保存してからコードを発行してください' USING errcode = '22023';
      ELSIF NOT (
        CASE shipping_method
          WHEN 'らくらくメルカリ便' THEN i.sales_channel = 'メルカリ'
            AND shipment_size IN ('100','140','宅急便コンパクト','ネコポス') AND dropoff IN ('セブンイレブン','ヤマト営業所')
          WHEN 'おてがる配送（ヤマト運輸）' THEN i.sales_channel = 'ヤフオク'
            AND shipment_size IN ('100','140','宅急便コンパクト') AND dropoff IN ('セブンイレブン','ヤマト営業所')
          WHEN 'ゆうゆうメルカリ便' THEN i.sales_channel = 'メルカリ'
            AND shipment_size IN ('100','140','ゆうパケットプラス','ゆうパケットポストmini','ゆうパケット') AND dropoff IN ('ローソン','郵便局')
          WHEN 'おてがる配送（日本郵便）' THEN i.sales_channel = 'ヤフオク'
            AND shipment_size IN ('100','140','ゆうパケットプラス','ゆうパケットポストmini','ゆうパケット') AND dropoff IN ('ローソン','郵便局')
          ELSE false
        END
      ) OR ((p_kind = 'register_package') <> (shipment_size = 'ゆうパケットポストmini')) THEN
        RAISE EXCEPTION '配送方法に対応する配送サイズと発送場所を選択してください' USING errcode = '22023';
      END IF;
    END;
  END IF;
$gate$;
begin
  if strpos(definition, shipping_gate)>0 then return; end if;
  if strpos(definition, old_gate)>0 then
    definition := replace(definition, old_gate, shipping_gate);
  elsif strpos(definition, '商品リストの配送サイズが未設定です')>0 then
    raise exception 'Existing catalog shipping check changed unexpectedly';
  elsif definition ~ listing_anchor then
    definition := regexp_replace(definition, listing_anchor, shipping_gate || '  IF p_kind = ''listing'' THEN');
  else
    raise exception 'Seller operation listing validation anchor not found';
  end if;
  execute definition;
end $migration$;
