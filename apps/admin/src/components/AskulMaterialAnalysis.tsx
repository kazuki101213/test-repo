import { useEffect, useRef, useState } from 'react';
import { yen } from '@bussan/shared';
import { analyzeMaterialPurchases, fetchExpenseStaffNames, fetchMaterialPurchases } from '../api';
import { summarizeMaterialPurchases, type MaterialAnalysis, type MaterialPurchase } from '../materialPurchases';

const japanMonth = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' }).slice(0, 7);
const average = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 1 });
const analysisLimit = 30;

export default function AskulMaterialAnalysis({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [month, setMonth] = useState(japanMonth);
  const [threshold, setThreshold] = useState('150');
  const [purchases, setPurchases] = useState<MaterialPurchase[]>([]);
  const [staff, setStaff] = useState<Record<string, string>>({});
  const [result, setResult] = useState<MaterialAnalysis | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);
  const lock = useRef(false);
  const percent = Number(threshold);
  const validMonth = /^\d{4}-(0[1-9]|1[0-2])$/.test(month) && Number(month.slice(0, 4)) >= 2000;
  const validThreshold = Number.isInteger(percent) && percent >= 101 && percent <= 1000;
  const rows = validMonth && validThreshold ? summarizeMaterialPurchases(purchases, month, percent) : [];

  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => {
    let active = true;
    setPurchases([]);
    setResult(null);
    setError('');
    setLoading(validMonth);
    if (validMonth) {
      Promise.all([fetchMaterialPurchases(month), fetchExpenseStaffNames()]).then(([rows, names]) => {
        if (active) { setPurchases(rows); setStaff(names); }
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
        comparisonMonths: row.comparisonMonths, increased: row.increased,
      }))));
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
      <label className="field"><span>購入増加の目安（平均に対する％）</span><input type="number" min={101} max={1000} step={1}
        value={threshold} disabled={analyzing} onChange={event => { setThreshold(event.currentTarget.value); setResult(null); }} /></label>
    </div>
    <p className="sub">直近3か月のうち同じ担当者・資材の購入実績がある月の平均と比較します。比較には2か月分が必要です。数量はCSVの出荷単位です。</p>
    {error && <p className="error" role="alert">{error}</p>}
    {!validMonth ? <p>集計する月を選択してください。</p> : !validThreshold ? <p>目安は101〜1,000％で入力してください。</p> : loading ? <p>読み込み中…</p>
      : rows.length ? <>
        <div className="scroll"><table>
          <thead><tr><th>担当者</th><th>資材</th><th className="num">購入数量</th><th className="num">税込金額</th><th className="num">過去平均数量</th><th>判定</th></tr></thead>
          <tbody>{rows.map(row => <tr key={row.key}>
            <td>{name(row.staffId)}</td><td>{row.name}</td><td className="num">{row.quantity.toLocaleString()}</td>
            <td className="num">{yen(row.amount)}</td><td className="num">{row.averageQuantity === null ? '—' : average.format(row.averageQuantity)}</td>
            <td>{row.averageQuantity === null ? '比較データ不足' : row.increased ? '購入増加' : '目安以内'}</td>
          </tr>)}</tbody>
        </table></div>
        <div className="toolbar"><button type="button" className="btn primary" disabled={analyzing}
          onClick={() => void analyze()}>{analyzing ? '分析中…' : 'Geminiで分析'}</button></div>
        {rows.length > analysisLimit && <p className="sub">Gemini分析の対象は、購入増加・金額順の先頭{analysisLimit}行です。</p>}
      </> : <p>この月の資材データがありません。出荷数量を含むアスクルCSVを取り込むと表示されます。</p>}
    {result && <section aria-label="Geminiの分析結果">
      <h3>Geminiの分析</h3><p>{result.summary}</p>
      {result.notes.length > 0 && <ul>{result.notes.map(note => {
        const row = rows[note.row - 1];
        return row ? <li key={note.row}><strong>{name(row.staffId)} {row.name}</strong> {note.reason}</li> : null;
      })}</ul>}
    </section>}
  </dialog>;
}
