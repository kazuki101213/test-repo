import { useEffect, useRef, useState } from 'react';
import { yen } from '@bussan/shared';
import { analyzeMaterialPurchases, fetchExpenseStaffNames, fetchMaterialPurchases, fetchMaterialWorkload } from '../api';
import { bubbleWrapMetresPerRecorder, summarizeBubbleWrap, summarizeMaterialPurchases, type MaterialAnalysis, type MaterialPurchase, type MaterialWorkload } from '../materialPurchases';

const japanMonth = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' }).slice(0, 7);
const average = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 1 });
const rate = new Intl.NumberFormat('ja-JP', { maximumSignificantDigits: 3 });
const analysisLimit = 30;

export default function AskulMaterialAnalysis({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [month, setMonth] = useState(japanMonth);
  const [threshold, setThreshold] = useState('150');
  const [purchases, setPurchases] = useState<MaterialPurchase[]>([]);
  const [workload, setWorkload] = useState(new Map<string, MaterialWorkload>());
  const [staff, setStaff] = useState<Record<string, string>>({});
  const [result, setResult] = useState<MaterialAnalysis | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);
  const lock = useRef(false);
  const percent = Number(threshold);
  const validMonth = /^\d{4}-(0[1-9]|1[0-2])$/.test(month) && Number(month.slice(0, 4)) >= 2000;
  const validThreshold = Number.isInteger(percent) && percent >= 101 && percent <= 1000;
  const rows = validMonth && validThreshold ? summarizeMaterialPurchases(purchases, month, percent, workload) : [];
  const bubbleWrap = validMonth ? summarizeBubbleWrap(purchases, month, workload) : [];

  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => {
    let active = true;
    setPurchases([]);
    setWorkload(new Map());
    setResult(null);
    setError('');
    setLoading(validMonth);
    if (validMonth) {
      Promise.all([fetchMaterialPurchases(month), fetchExpenseStaffNames(), fetchMaterialWorkload(month)]).then(([rows, names, counts]) => {
        if (active) { setPurchases(rows); setStaff(names); setWorkload(counts); }
      }).catch(cause => {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      }).finally(() => { if (active) setLoading(false); });
    }
    return () => { active = false; };
  }, [month, validMonth]);

  async function analyze() {
    if (lock.current || !rows.length) return;
    lock.current = true;
    setAnalyzing(true);
    setError('');
    setResult(null);
    try {
      setResult(await analyzeMaterialPurchases(rows.slice(0, analysisLimit).map((row, index) => ({
        row: index + 1, quantity: row.quantity, amount: row.amount, averageQuantity: row.averageQuantity,
        comparisonMonths: row.comparisonMonths, increased: row.increased, completedItems: row.completedItems,
        quantityPerItem: row.quantityPerItem, peerQuantityPerItem: row.peerQuantityPerItem, peerCount: row.peerCount, abovePeers: row.abovePeers,
      })), bubbleWrap.filter(entry => entry.purchasedMetres !== null).slice(0, analysisLimit)
        .map(({ recorderItems, estimatedMetres, purchasedMetres }) => ({ recorderItems, estimatedMetres, purchasedMetres }))));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      lock.current = false;
      setAnalyzing(false);
    }
  }

  const name = (staffId: string | null) => staffId ? staff[staffId] || '未確認' : '未特定';
  return <dialog ref={dialog} className="monthly-detail" aria-label="アスクル資材の購入分析" onCancel={event => {
    event.preventDefault();
    if (!lock.current) onClose();
  }}>
    <div className="toolbar"><h2>アスクル資材の購入分析</h2><button type="button" className="btn" onClick={onClose} disabled={analyzing}>閉じる</button></div>
    <div className="toolbar">
      <label className="field"><span>集計月</span><input type="month" min="2000-01" value={month} disabled={analyzing}
        onChange={event => setMonth(event.currentTarget.value)} /></label>
      <label className="field"><span>確認の目安（比較値に対する％）</span><input type="number" min={101} max={1000} step={1}
        value={threshold} disabled={analyzing} onChange={event => { setThreshold(event.currentTarget.value); setResult(null); }} /></label>
    </div>
    <p className="sub">同じ月・同じ資材を買った他の担当者と、作業完了1件あたりの購入量を比べます。作業完了件数は付属品を除いた商品数です。数量はCSVの出荷単位です。</p>
    {error && <p className="error" role="alert">{error}</p>}
    {!validMonth ? <p>集計する月を選択してください。</p> : !validThreshold ? <p>目安は101〜1,000％で入力してください。</p> : loading ? <p>読み込み中…</p>
      : rows.length ? <>
        <div className="scroll"><table>
          <thead><tr><th>担当者</th><th>資材</th><th className="num">購入数量</th><th className="num">税込金額</th><th className="num">作業完了</th><th className="num">購入量／件</th><th className="num">他担当の購入量／件</th><th>判定</th></tr></thead>
          <tbody>{rows.map(row => <tr key={row.key}>
            <td>{name(row.staffId)}</td><td>{row.name}</td><td className="num">{row.quantity.toLocaleString()}
              {row.averageQuantity !== null && <div><small>過去平均 {average.format(row.averageQuantity)}</small></div>}</td>
            <td className="num">{yen(row.amount)}</td><td className="num">{row.staffId ? row.completedItems.toLocaleString() : '—'}</td>
            <td className="num">{row.quantityPerItem === null ? '—' : rate.format(row.quantityPerItem)}</td>
            <td className="num">{row.peerQuantityPerItem === null ? '—' : `${rate.format(row.peerQuantityPerItem)}（${row.peerCount}人）`}</td>
            <td>{row.abovePeers && row.peerQuantityPerItem !== null && row.quantityPerItem !== null
              ? <strong>他担当の{rate.format(row.quantityPerItem / row.peerQuantityPerItem)}倍</strong>
              : row.peerQuantityPerItem === null ? '担当者比較なし' : '比較の目安以内'}
              {row.increased && <div>過去の月間平均より増加</div>}</td>
          </tr>)}</tbody>
        </table></div>
        <div className="toolbar"><button type="button" className="btn primary" disabled={analyzing}
          onClick={() => void analyze()}>{analyzing ? '分析中…' : 'Geminiで分析'}</button></div>
        {rows.length > analysisLimit && <p className="sub">Geminiは他担当より購入ペースが高い明細から{analysisLimit}行まで分析します。</p>}
      </> : <p>この月の資材データがありません。出荷数量を含むアスクルCSVを取り込むと表示されます。</p>}
    {!loading && bubbleWrap.length > 0 && <section aria-label="プチプチの使用目安">
      <h3>プチプチの使用目安</h3>
      <p className="sub">ブルーレイレコーダー1台あたり約{bubbleWrapMetresPerRecorder}m。購入時期や手元在庫、ほかの商品への使用で、購入した長さと使用量には差が出ます。</p>
      <div className="scroll"><table>
        <thead><tr><th>担当者</th><th className="num">レコーダー作業完了</th><th className="num">レコーダーの使用目安</th><th className="num">購入した長さ</th></tr></thead>
        <tbody>{bubbleWrap.map(row => <tr key={row.staffId}>
          <td>{name(row.staffId)}</td><td className="num">{row.recorderItems.toLocaleString()}台</td>
          <td className="num">約{row.estimatedMetres.toLocaleString()}m</td>
          <td className="num">{row.purchasedMetres !== null ? `${average.format(row.purchasedMetres)}m`
            : row.hasPurchase ? '長さ不明' : '購入記録なし'}</td>
        </tr>)}</tbody>
      </table></div>
    </section>}
    {result && <section aria-label="Geminiの分析結果">
      <h3>Geminiの分析</h3><p>{result.summary}</p>
      {result.notes.length > 0 && <ul>{result.notes.map(note => {
        const row = rows[note.row - 1];
        return row ? <li key={note.row}><strong>{name(row.staffId)} {row.name}</strong> {note.reason}</li> : null;
      })}</ul>}
    </section>}
  </dialog>;
}
