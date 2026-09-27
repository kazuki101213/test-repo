/** Amazon の在庫ファイルはタブ区切り */
export function downloadTsv(filename: string, rows: Record<string, unknown>[]): void {
  if (rows.length === 0) return;
  const headers = Object.keys(rows[0]!);
  const tsv = [
    headers.join('\t'),
    ...rows.map((r) => headers.map((h) => String(r[h] ?? '').replace(/[\t\r\n]/g, ' ')).join('\t')),
  ].join('\r\n');

  const blob = new Blob(['﻿' + tsv], { type: 'text/tab-separated-values;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
