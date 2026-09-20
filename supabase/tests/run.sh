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
  $PSQL -v ON_ERROR_STOP=1 -q -d "$DB" -f "$f"
done

$PSQL -v ON_ERROR_STOP=1 -q -d "$DB" -f "$HERE/smoke.sql"

# アプリが読む列・関数がこのスキーマに存在するかを突き合わせる
DB="$DB" "$HERE/check-app-schema.py"

echo "すべて成功しました"
