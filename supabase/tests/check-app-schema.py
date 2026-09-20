#!/usr/bin/env python3
"""アプリが読む列・関数・テーブルが、実際の DB に存在するかを突き合わせる。

TypeScript の型は手で書いているので、マイグレーションを直したときに
型だけ取り残されると、ビルドは通るのに画面が壊れる。
それを CI で捕まえるためのチェック。

PostgreSQL の識別子は引用符で囲まないと小文字に畳まれるため、
`as 取引記録URL` のような別名は `取引記録url` になる。
この手の取り違えは型チェックでは検出できない。

    DB=bussan_test supabase/tests/check-app-schema.py
"""
import os
import re
import subprocess
import sys
from pathlib import Path

DB = os.environ.get('DB', 'bussan_test')
ROOT = Path(__file__).resolve().parents[2]


def query(sql: str) -> list[str]:
    env = {**os.environ}
    out = subprocess.run(['psql', '-q', '-d', DB, '-tAc', sql],
                         capture_output=True, text=True, env=env)
    if out.returncode != 0:
        sys.exit(f'psql に接続できません: {out.stderr.strip()}')
    return [l for l in out.stdout.strip().split('\n') if l]


def interface_fields(ts: str, name: str) -> set[str] | None:
    m = re.search(r'export interface ' + name + r'\s*\{(.*?)\n\}', ts, re.S)
    if not m:
        return None
    return set(re.findall(r'^\s*([A-Za-z_぀-鿿][\w぀-鿿]*)\??:',
                          m.group(1), re.M))


VIEWS = [
    ('v_items', 'ItemView'),
    ('v_delivery_tasks', 'DeliveryTask'),
    ('v_monthly_summary', 'MonthlySummary'),
    ('v_stock_summary', 'StockSummary'),
    ('v_deliverer_workload', 'DelivererWorkload'),
    ('v_antique_ledger', 'LedgerRow'),
]

RPCS = ['set_work_progress', 'update_delivery_fields', 'find_by_sku', 'link_login']

TABLES = ['staff', 'profiles', 'payment_cards', 'products', 'items',
          'item_photos', 'item_comments', 'import_conflicts']


def main() -> None:
    ts = (ROOT / 'packages/shared/src/types.ts').read_text()
    failures = 0

    print('ビューの列とアプリの型:')
    for view, name in VIEWS:
        cols = set(query(
            "select column_name from information_schema.columns "
            f"where table_schema='app' and table_name='{view}'"))
        if not cols:
            print(f'  NG  {view}: ビューが存在しません')
            failures += 1
            continue
        fields = interface_fields(ts, name)
        if fields is None:
            print(f'  NG  {name}: TypeScript の型が見つかりません')
            failures += 1
            continue
        missing = sorted(fields - cols)
        if missing:
            print(f'  NG  {view:22} {name:20} アプリが要求するが DB に無い列: {missing}')
            failures += 1
        else:
            print(f'  OK  {view:22} {name:20} ({len(cols)} 列)')

    print('\nアプリが呼ぶ関数:')
    have = set(query("select proname from pg_proc p "
                     "join pg_namespace n on n.oid = p.pronamespace "
                     "where n.nspname='app'"))
    for fn in RPCS:
        ok = fn in have
        failures += 0 if ok else 1
        print(f'  {"OK" if ok else "NG"}  app.{fn}')

    print('\nアプリが読み書きするテーブル:')
    for t in TABLES:
        ok = bool(query("select 1 from information_schema.tables "
                        f"where table_schema='app' and table_name='{t}'"))
        failures += 0 if ok else 1
        print(f'  {"OK" if ok else "NG"}  app.{t}')

    if failures:
        sys.exit(f'\n{failures} 件の食い違いがあります。'
                 'マイグレーションか packages/shared/src/types.ts を直してください。')
    print('\nすべて一致しました')


if __name__ == '__main__':
    main()
