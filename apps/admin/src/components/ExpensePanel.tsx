import { useEffect, useRef, useState, type FormEvent } from 'react';
import { yen, type Staff } from '@bussan/shared';
import { fetchCards, fetchStaff, saveExpense } from '../api';
import { expenseCategories, type ExpenseInput } from '../expenses';

export default function ExpensePanel({ onSaved, onBusyChange }: { onSaved: () => void; onBusyChange: (busy: boolean) => void }) {
  const [date, setDate] = useState(() => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10));
  const [category, setCategory] = useState<ExpenseInput['category']>('諸経費');
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [card, setCard] = useState('');
  const [staffId, setStaffId] = useState('');
  const [memo, setMemo] = useState('');
  const [cards, setCards] = useState<{ id: string; name: string }[]>([]);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const [busy, setBusy] = useState(false);
  const id = useRef(crypto.randomUUID());
  const saving = useRef(false);

  useEffect(() => {
    let active = true;
    Promise.all([fetchCards(), fetchStaff()])
      .then(([c, s]) => { if (active) { setCards(c); setStaff(s); } })
      .catch(e => { if (active) setError(e instanceof Error ? e.message : String(e)); });
    return () => { active = false; };
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (saving.current) return;
    saving.current = true; setBusy(true); onBusyChange(true); setError(''); setDone('');
    try {
      if (!amount.trim()) throw new Error('金額を入力してください。');
      const input: ExpenseInput = { id: id.current, incurred_on: date, category, name: name.trim(), amount: Number(amount),
        card_id: card || null, staff_id: staffId || null, memo: memo.trim() || null };
      await saveExpense(input);
      setDone(`${date} ${input.name} ${yen(input.amount)} を保存しました。`);
      id.current = crypto.randomUUID();
      setName(''); setAmount(''); setMemo('');
      onSaved();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { saving.current = false; setBusy(false); onBusyChange(false); }
  }

  return <aside id="expense-panel" className="expense-panel card" aria-label="経費入力パネル">
    <div className="toolbar"><h2>経費入力</h2></div>
    {error && <div className="error" role="alert">{error}</div>}
    {done && <div className="ok" role="status">{done}</div>}
    <form onSubmit={submit}>
      <fieldset disabled={busy} className="expense-fields">
        <label className="field"><span>経費の日付</span><input type="date" required value={date} onChange={e => setDate(e.target.value)} /></label>
        <label className="field"><span>経費の区分</span><select value={category} onChange={e => setCategory(e.target.value as ExpenseInput['category'])}>{expenseCategories.map(c => <option key={c}>{c}</option>)}</select></label>
        <label className="field expense-wide"><span>経費の内容</span><input type="text" required maxLength={200} value={name} onChange={e => setName(e.target.value)} placeholder="梱包資材、家賃など" /></label>
        <label className="field expense-wide"><span>経費の金額（円・返金はマイナス）</span><input type="number" required step={1} value={amount} onChange={e => setAmount(e.target.value)} /></label>
        <label className="field"><span>支払いカード</span><select value={card} onChange={e => setCard(e.target.value)}><option value="">未指定</option>{cards.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        <label className="field"><span>経費の担当者</span><select value={staffId} onChange={e => setStaffId(e.target.value)}><option value="">未指定</option>{staff.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <label className="field expense-wide"><span>経費のメモ</span><textarea rows={2} value={memo} onChange={e => setMemo(e.target.value)} /></label>
        <button className="btn primary expense-wide" type="submit">{busy ? '保存中…' : '経費を保存'}</button>
      </fieldset>
    </form>
  </aside>;
}
