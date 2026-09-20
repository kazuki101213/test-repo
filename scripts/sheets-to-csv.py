#!/usr/bin/env python3
"""スプレッドシート(.xlsx) → CSV 書き出し

Google スプレッドシートを「ファイル → ダウンロード → Microsoft Excel (.xlsx)」で
落としてから、このスクリプトにかける。シートごとに CSV ができる。

    pip install openpyxl
    python3 scripts/sheets-to-csv.py 総合管理表.xlsx 納品管理表.xlsx --out data

CSV を直接ダウンロードすると先頭シートしか取れないので、.xlsx 経由にしている。
"""
import argparse
import csv
import re
import sys
from pathlib import Path

try:
    import openpyxl
except ImportError:
    sys.exit("openpyxl が必要です:  pip install openpyxl")


def cell_to_text(value) -> str:
    """日付は YYYY-MM-DD に、それ以外は文字列にする。"""
    if value is None:
        return ""
    if hasattr(value, "strftime"):
        # 1899-12-30 は「空の日付」がシリアル 0 になったもの。空として扱う。
        if getattr(value, "year", 0) <= 1900:
            return ""
        return value.strftime("%Y-%m-%d")
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def safe_name(name: str) -> str:
    return re.sub(r'[^\w\-()（）]', "_", name)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("workbooks", nargs="+", help="変換する .xlsx")
    ap.add_argument("--out", default="data", help="出力先ディレクトリ")
    ap.add_argument("--sheets", nargs="*", help="このシートだけ書き出す（省略時は全部）")
    args = ap.parse_args()

    out_root = Path(args.out)

    for path in args.workbooks:
        wb = openpyxl.load_workbook(path, data_only=True, read_only=True)
        book = Path(path).stem
        out_dir = out_root / safe_name(book)
        out_dir.mkdir(parents=True, exist_ok=True)

        for ws in wb.worksheets:
            if args.sheets and ws.title not in args.sheets:
                continue
            rows = [[cell_to_text(c) for c in row] for row in ws.iter_rows(values_only=True)]
            rows = [r for r in rows if any(c.strip() for c in r)]
            if not rows:
                continue
            dest = out_dir / f"{safe_name(ws.title)}.csv"
            with dest.open("w", newline="", encoding="utf-8") as f:
                csv.writer(f).writerows(rows)
            print(f"{book} / {ws.title}  →  {dest}  ({len(rows)} 行)")


if __name__ == "__main__":
    main()
