-- =============================================================================
-- Amazon 出品用フィード
--   納品管理表の「出品テンプレート」シートを置き換える。
--   写真登録まで終わった SKU を、Amazon の在庫ファイル形式で出力する。
-- =============================================================================
create view app.v_amazon_listing_feed with (security_invoker = on) as
select
  i.sku                                     as "sku",
  i.planned_price                           as "price",
  1                                         as "quantity",
  i.asin                                    as "product-id",
  'ASIN'                                    as "product-id-type",
  cm.amazon_code                            as "condition-type",
  i.description                             as "condition-note",
  i.title                                   as "title",
  'Update'                                  as "operation-type",
  case i.sales_channel
    when 'FBA' then 'AMAZON_NA'
    else 'DEFAULT'
  end                                       as "fulfillment-center-id",
  (
    select 'https://' || current_setting('app.storage_host', true) || '/' || ph.storage_path
    from app.item_photos ph
    where ph.item_id = i.id and ph.is_main
    limit 1
  )                                         as "main-offer-image",
  i.id                                      as item_id,
  i.status,
  i.deliverer_id
from app.items i
left join app.condition_map cm on cm.condition = i.condition
where i.asin is not null
  and i.planned_price is not null
  and i.photo_uploaded_at is not null
  and i.status in ('作業中', '出荷済', '出品中');

grant select on app.v_amazon_listing_feed to authenticated;
