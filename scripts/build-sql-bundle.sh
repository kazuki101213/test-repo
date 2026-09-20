#!/usr/bin/env bash
# supabase/migrations/*.sql を 1 つのファイルにまとめる。
#
# Supabase CLI を入れずに、ダッシュボードの SQL Editor に
# 1 回貼り付けるだけでセットアップを終わらせるためのもの。
#
#   scripts/build-sql-bundle.sh          まとめて supabase/setup-all.sql に書く
#   scripts/build-sql-bundle.sh --check  中身がずれていないか確認するだけ
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$HERE/supabase/setup-all.sql"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

{
  cat <<'HEADER'
-- =============================================================================
-- 物販管理システム — セットアップ用 SQL（自動生成）
--
--   このファイルは supabase/migrations/*.sql を連結したものです。
--   直接編集しないでください。migrations 側を直して
--   scripts/build-sql-bundle.sh を実行し直してください。
--
-- 使い方
--   1. Supabase のダッシュボードで左メニューの「SQL Editor」を開く
--   2. このファイルの中身を全部コピーして貼り付ける
--   3. 右下の「Run」を押す
--
--   何度流しても壊れないようには作っていません。エラーが出た場合は
--   一度 `drop schema app cascade;` で消してから流し直してください。
-- =============================================================================

HEADER

  for f in "$HERE"/supabase/migrations/*.sql; do
    printf -- '-- ▼▼▼ %s ▼▼▼\n\n' "$(basename "$f")"
    cat "$f"
    printf '\n\n'
  done
} > "$TMP"

if [[ "${1:-}" == "--check" ]]; then
  if ! diff -q "$TMP" "$OUT" > /dev/null 2>&1; then
    echo "supabase/setup-all.sql が migrations と食い違っています。" >&2
    echo "scripts/build-sql-bundle.sh を実行して結果をコミットしてください。" >&2
    diff "$OUT" "$TMP" | head -40 >&2 || true
    exit 1
  fi
  echo "supabase/setup-all.sql は最新です"
  exit 0
fi

mv "$TMP" "$OUT"
trap - EXIT
echo "生成しました: supabase/setup-all.sql ($(wc -l < "$OUT") 行)"
