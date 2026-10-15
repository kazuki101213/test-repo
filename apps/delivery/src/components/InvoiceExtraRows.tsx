import { useState } from 'react';
import type { InvoiceLine } from '../invoices';
import DateInput from './DateInput';

type Draft = { date: string; description: string; quantity: string; amount: string };
const blank = (): Draft => ({ date: '', description: '', quantity: '', amount: '' });
export default function InvoiceExtraRows({ lines, disabled, onChange, onDraftChange }: {
  lines: InvoiceLine[]; disabled: boolean; onChange: (lines: InvoiceLine[]) => void; onDraftChange: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(blank);
  const [error, setError] = useState('');
  function add() {
    const quantity = Number(draft.quantity), amount = Number(draft.amount);
    if (!draft.description.trim() || !draft.quantity || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 100000 || !draft.amount || !Number.isSafeInteger(amount) || amount < 0 || amount > 10000000 || (draft.date && (!/^\d{4}-\d{2}-\d{2}$/.test(draft.date) || Number.isNaN(Date.parse(draft.date))))) {
      setError('内容・数量（1以上）・金額（0円以上）を入力してください。日付はYYYY-MM-DD形式で入力してください。'); return;
    }
    onChange([...lines, { date: draft.date || null, description: draft.description.trim(), quantity, unit_price: amount }]);
    setDraft(blank()); setError('');
  }
  function changeDraft(patch: Partial<Draft>) { setDraft({ ...draft, ...patch }); setError(''); onDraftChange(); }
  function change(index: number, patch: Partial<InvoiceLine>) { onChange(lines.map((line, i) => i === index ? { ...line, ...patch } : line)); }
  return <>
    <div className="invoice-extra-scroll">
      {lines.map((line, i) => <div className="invoice-extra" key={i}>
        <label>日付<DateInput value={line.date ?? ''} disabled={disabled} onChange={e => change(i, { date: e.target.value || null })} /></label>
        <label>内容<input required maxLength={200} value={line.description} disabled={disabled} list="invoice-extra-descriptions" onChange={e => change(i, { description: e.target.value })} /></label>
        <label>数量<input required type="number" min="1" max="100000" step="1" value={line.quantity} disabled={disabled} onChange={e => change(i, { quantity: e.target.valueAsNumber })} /></label>
        <label>金額<input required type="number" min="0" max="10000000" step="1" value={line.unit_price} disabled={disabled} onChange={e => change(i, { unit_price: e.target.valueAsNumber })} /></label>
        <button type="button" className="btn ghost" aria-label={`${i + 1}行目を削除`} disabled={disabled} onClick={() => onChange(lines.filter((_, index) => index !== i))}>削除</button>
      </div>)}
      <div className="invoice-extra invoice-extra-draft">
        <label>日付<DateInput form="invoice-extra-draft" value={draft.date} disabled={disabled} onChange={e => changeDraft({ date: e.target.value })} /></label>
        <label>内容<input form="invoice-extra-draft" maxLength={200} value={draft.description} disabled={disabled} list="invoice-extra-descriptions" onChange={e => changeDraft({ description: e.target.value })} /></label>
        <label>数量<input form="invoice-extra-draft" type="number" min="1" max="100000" step="1" value={draft.quantity} disabled={disabled} onChange={e => changeDraft({ quantity: e.target.value })} /></label>
        <label>金額<input form="invoice-extra-draft" type="number" min="0" max="10000000" step="1" value={draft.amount} disabled={disabled} onChange={e => changeDraft({ amount: e.target.value })} /></label>
        <button type="button" className="btn" disabled={disabled || lines.length >= 100} onClick={add}>保存</button>
      </div>
    </div>
    <datalist id="invoice-extra-descriptions"><option value="手当" /><option value="保管料" /></datalist>
    {error && <p className="error" role="alert">{error}</p>}
  </>;
}