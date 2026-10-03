-- These Amazon返品 rows were still classified as accessories and carried only
-- a sale date mirrored from their parent item. Promote them to independent main
-- items, preserve their old SKUs as aliases, and restore the return workflow.
with targets(old_sku, new_sku) as (
  values
    ('724-AAEE-20251208-298', '724a-AAEE-20251208-298'),
    ('780-AAHH-20251225-298', '780a-AAHH-20251225-298'),
    ('840-AAHH-20251224-0', '840a-AAHH-20251224-0'),
    ('1310-AAII-20260226-0', '1310a-AAII-20260226-0'),
    ('1586-AAHH-20260521-298', '1586a-AAHH-20260521-298'),
    ('1812-AAII-20260615-74', '1812a-AAII-20260615-74'),
    ('1929-AAHH-20260622-74', '1929a-AAHH-20260622-74'),
    ('1929-AAHH-20260715-74', '1929aa-AAHH-20260715-74')
)
update app.items i
set sku = t.new_sku,
    is_accessory = false,
    sold_on = null,
    status = 'Amazon返品',
    updated_at = now()
from targets t
where i.sku = t.old_sku
  and i.marketplace::text = 'Amazon返品'
  and i.is_accessory
  and i.status::text = '販売済'
  and i.sold_on is not null
  and i.sold_price is null
  and i.payout_amount is null;
