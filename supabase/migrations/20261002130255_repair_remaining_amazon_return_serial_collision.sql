-- A later Amazon返品 row was added with an already-used "a" serial after the
-- initial reconciliation. Give that third physical row its next distinct suffix.
update app.items
set sku = '1894aaa-II-18991230-0',
    updated_at = now()
where sku = '1894a-II-18991230-0'
  and lot_seq = 1894
  and marketplace::text = 'Amazon返品'
  and not is_accessory;
