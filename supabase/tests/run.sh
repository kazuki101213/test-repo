#!/usr/bin/env bash
# ローカルの PostgreSQL にマイグレーションを流して、RLS と SKU 採番を検証する。
# Supabase CLI がなくても動くよう、auth / storage スキーマはスタブで代用する。
#
#   sudo service postgresql start
#   supabase/tests/run.sh
set -euo pipefail

DB="${DB:-bussan_test}"
PSQL="${PSQL:-psql}"
HERE="$(cd "$(dirname "$0")" && pwd)"

dropdb --if-exists "$DB"
createdb "$DB"

$PSQL -v ON_ERROR_STOP=1 -q -d "$DB" -f "$HERE/_supabase_stub.sql"
for f in "$HERE"/../migrations/*.sql; do
  echo "== $(basename "$f")"
  # The disposable CI database has cron/Vault stubs above. Extension binaries
  # are installed by Supabase in production, not by the plain postgres image.
  sed -E '/^create extension if not exists (pg_cron|pg_net) /Id' "$f" |
    $PSQL --single-transaction -v ON_ERROR_STOP=1 -q -d "$DB" -f -
done

$PSQL -v ON_ERROR_STOP=1 -q -d "$DB" -f "$HERE/smoke.sql"

$PSQL -v ON_ERROR_STOP=1 -q -d "$DB" -f "$HERE/product_family_accounting.sql"
$PSQL -v ON_ERROR_STOP=1 -q -d "$DB" -f "$HERE/serial_delivery_invoice.sql"
$PSQL -v ON_ERROR_STOP=1 -q -d "$DB" -f "$HERE/spare_holder_manufacturer.sql"
$PSQL -v ON_ERROR_STOP=1 -q -d "$DB" -f "$HERE/receipt_details_invoice.sql"



$PSQL -v ON_ERROR_STOP=1 -q -d "$DB" -f "$HERE/management_access.sql"

$PSQL -v ON_ERROR_STOP=1 -q -d "$DB" -f "$HERE/dated_sale_status.sql"

$PSQL -v ON_ERROR_STOP=1 -q -d "$DB" -f "$HERE/ten_state_workflow.sql"

$PSQL -v ON_ERROR_STOP=1 -q -d "$DB" -f "$HERE/paged_inventory_sync.sql"

$PSQL -v ON_ERROR_STOP=1 -q -d "$DB" -f "$HERE/resource_snapshot.sql"

$PSQL -v ON_ERROR_STOP=1 -q -d "$DB" -f "$HERE/state_specific_actions.sql"
$PSQL -v ON_ERROR_STOP=1 -q -d "$DB" -f "$HERE/seller_shipping_preferences.sql"

$PSQL -v ON_ERROR_STOP=1 -q -d "$DB" -f "$HERE/explicit_spare_parent.sql"
$PSQL -v ON_ERROR_STOP=1 -q -d "$DB" -f "$HERE/spare_shipping_recipient.sql"

$PSQL -v ON_ERROR_STOP=1 -q -d "$DB" -f "$HERE/packing_photos.sql"

$PSQL -v ON_ERROR_STOP=1 -q -d "$DB" -f "$HERE/four_account_sales.sql"

$PSQL -v ON_ERROR_STOP=1 -q -d "$DB" -f "$HERE/listing_photo_approval.sql"

$PSQL -v ON_ERROR_STOP=1 -q -d "$DB" -f "$HERE/inspection_receipt_tasks.sql"

$PSQL -v ON_ERROR_STOP=1 -q -d "$DB" -f "$HERE/listing_result_check.sql"

$PSQL -v ON_ERROR_STOP=1 -q -d "$DB" -f "$HERE/deliverer_workload_inventory.sql"

$PSQL -v ON_ERROR_STOP=1 -q -d "$DB" -f "$HERE/delivery_all_products_catalog.sql"

# アプリが読む列・関数がこのスキーマに存在するかを突き合わせる
DB="$DB" "$HERE/check-app-schema.py"

echo "すべて成功しました"
