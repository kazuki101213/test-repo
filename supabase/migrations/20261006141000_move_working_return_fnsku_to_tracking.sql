-- Older working returns stored FNSKU in title. Preserve that source for older
-- clients while copying the identifier into its new field without overwriting
-- existing tracking values. Safe to run against an empty database or rerun.
update app.items
set tracking_no = btrim(title)
where marketplace::text = '動作品Amazon返品'
  and nullif(btrim(tracking_no), '') is null
  and btrim(title) ~ '^X[A-Z0-9]{9}$';
