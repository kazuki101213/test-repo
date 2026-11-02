import { useEffect, useState } from 'react';
import { jpDate, yen } from '@bussan/shared';
import { fetchLedger } from '../api';
import type { LedgerDisplayRow } from '../api';
import { downloadCsv } from '../csv';
import { purchaseItemUrl } from '../purchaseUrl';
import DateInput from '../components/DateInput';


function firstOfYear(): string {
  return `${new Date().getFullYear()}-01-01`;
}

export default function Ledger() {
  const [from, setFrom] = useState(firstOfYear());
  const [to, setTo] = useState(new Date().toISOString().slice(0, 10));
  const [rows, setRows] = useState<LedgerDisplayRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    const valid = (value: string) => {
      const parsed = new Date(value + 'T00:00:00Z');
      return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0,10) === value;
    };
    if (!valid(from) || !valid(to) || from > to) {
      setRows([]); setLoading(false); setError(from && to && from > to ? '終了日は開始日以降の日付を選んでください。' : null);
      return;
    }
    setLoading(true); setError(null);
    void fetchLedger(from, to).then(data=>{if(active)setRows(data);})
      .catch(e=>{if(active){setRows([]);setError(e instanceof Error ? e.message : String(e));}})
      .finally(()=>{if(active)setLoading(false);});
    return ()=>{active=false;};
  }, [from,to]);

  return (
    <>

      <div className="toolbar ledger-toolbar">
        <div className="ledger-date-range" role="group" aria-label="取引日の期間">
          <DateInput aria-label="取引日・開始日" value={from} max={to || undefined} onChange={e=>setFrom(e.target.value)} />
          <span className="ledger-date-separator" aria-hidden="true">〜</span>
          <DateInput aria-label="取引日・終了日" value={to} min={from || undefined} onChange={e=>setTo(e.target.value)} />
        </div>
        <button className="btn" disabled={loading || !!error || !rows.length} onClick={() => downloadCsv(`古物台帳_${from}_${to}.csv`, rows.map(r => ({ ...r, 商品URL: r.取引区分 === '買受' ? purchaseItemUrl(r.仕入先, r.商品ID, r.取引記録リンク) : null })) as unknown as Record<string, unknown>[])}>CSV</button>
        <span className="ledger-count" aria-live="polite">{loading ? '読み込み中…' : `${rows.length.toLocaleString()} 件`}</span>
      </div>

      {error && <div className="error">{error}</div>}
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th>取引年月日</th><th>区分</th><th>品目</th><th>特徴</th>
              <th className="num">数量</th><th className="num">代価</th>
              <th>相手方</th><th>住所</th><th>確認方法</th><th>買取URL</th><th>SKU</th>
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
                <td>{r.取引区分 === '買受' && (() => {
                  const url = purchaseItemUrl(r.仕入先, r.商品ID, r.取引記録リンク);
                  return url ? <a href={url} target="_blank" rel="noopener noreferrer">{r.仕入先 ?? '商品'} {r.商品ID ?? 'ページ'}</a> : '—';
                })()}</td>
                <td className="sku">{r.sku}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
