import { useCallback, useEffect, useState } from 'react';
import { jpDate, yen } from '@bussan/shared';
import type { LedgerRow } from '@bussan/shared';
import { fetchLedger } from '../api';
import { downloadCsv } from '../csv';

function firstOfYear(): string {
  return `${new Date().getFullYear()}-01-01`;
}

export default function Ledger() {
  const [from, setFrom] = useState(firstOfYear());
  const [to, setTo] = useState(new Date().toISOString().slice(0, 10));
  const [rows, setRows] = useState<LedgerRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    fetchLedger(from, to)
      .then(setRows)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [from, to]);

  useEffect(() => { load(); }, [load]);

  // 1万円以上の買受で相手方が特定できていない行は、古物台帳として不備になる
  const incomplete = rows.filter(
    (r) => r.取引区分 === '買受' && r.代価 >= 10000 && !r.相手方住所,
  ).length;

  return (
    <>
      <h2>古物台帳</h2>
      <p className="sub">
        古物営業法施行規則 第16条の記載事項に対応した帳簿です。最終取引日から3年間は保存してください。
      </p>

      <div className="toolbar">
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        <span className="sub" style={{ margin: 0 }}>〜</span>
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        <button className="btn" onClick={load}>表示</button>
        <span className="sub" style={{ margin: 0 }}>{rows.length} 件</span>
        <span style={{ flex: 1 }} />
        <button className="btn primary" onClick={() => downloadCsv(`古物台帳_${from}_${to}.csv`, rows as unknown as Record<string, unknown>[])}>
          CSV出力
        </button>
      </div>

      {error && <div className="error">{error}</div>}
      {incomplete > 0 && (
        <div className="error">
          1万円以上の買受のうち {incomplete} 件で相手方の住所が未記入です。
          非対面取引の記録（取引ID・URL）だけでは不足する場合があるため、確認をおすすめします。
        </div>
      )}

      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th>取引年月日</th><th>区分</th><th>品目</th><th>特徴</th>
              <th className="num">数量</th><th className="num">代価</th>
              <th>相手方</th><th>住所</th><th>確認方法</th><th>SKU</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={`${r.sku}-${r.取引区分}-${i}`}>
                <td>{jpDate(r.取引年月日)}</td>
                <td><span className="badge">{r.取引区分}</span></td>
                <td>{r.品目}</td>
                <td title={r.特徴} style={{ maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.特徴}</td>
                <td className="num">{r.数量}</td>
                <td className="num">{yen(r.代価)}</td>
                <td>{r.相手方}</td>
                <td>{r.相手方住所 ?? '—'}</td>
                <td>{r.確認方法 ?? '—'}</td>
                <td className="sku">{r.sku}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
