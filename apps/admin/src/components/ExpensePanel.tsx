import { useEffect, useRef, useState, type FormEvent } from 'react';
import { yen, type Staff } from '@bussan/shared';
import { fetchCards, fetchRecentExpenses, fetchStaff, saveExpense } from '../api';
import { expenseCategories, type ExpenseInput } from '../expenses';

export default function ExpensePanel({ onClose, onSaved, onBusyChange }: { onClose: () => void; onSaved: () => void; onBusyChange: (busy: boolean) => void }) {
  const [date, setDate] = useState(() => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10));
  const [category, setCategory] = useState<ExpenseInput['category']>('諸経費');
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [card, setCard] = useState('');
  const [staffId, setStaffId] = useState('');
  const [memo, setMemo] = useState('');
  const [cards, setCards] = useState<{ id: string; name: string }[]>([]);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [recent, setRecent] = useState<ExpenseInput[]>([]);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const [busy, setBusy] = useState(false);
  const id = useRef(crypto.randomUUID());
  const saving = useRef(false);

  useEffect(() => {
    let active = true;
    Promise.all([fetchCards(), fetchStaff(), fetchRecentExpenses()])
      .then(([c, s, r]) => { if (active) { setCards(c); setStaff(s); setRecent(r); } })
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
      setRecent(rows => [input, ...rows.filter(row => row.id !== input.id)].sort((a, b) => b.incurred_on.localeCompare(a.incurred_on)).slice(0, 20));
      id.current = crypto.randomUUID();
      setName(''); setAmount(''); setMemo('');
      onSaved();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { saving.current = false; setBusy(false); onBusyChange(false); }
  }

  return <aside id="expense-panel" className="expense-panel card" aria-label="経費入力パネル">
    <div className="toolbar"><h2>経費入力</h2><span style={{ flex: 1 }} /><button className="btn" disabled={busy} onClick={onClose}>閉じる</button></div>
    {error && <div className="error" role="alert">{error}</div>}
    {done && <div className="ok" role="status">{done}</div>}
    <form onSubmit={submit}>
      <fieldset disabled={busy} className="expense-fields">
        <label className="field"><span>経費の日付</span><input type="date" required value={date} onChange={e => setDate(e.target.value)} /></label>
        <label className="field"><span>経費の区分</span><select value={category} onChange={e => setCategory(e.target.value as ExpenseInput['category'])}>{expenseCategories.map(c => <option key={c}>{c}</option>)}</select></label>
        <label className="field"><span>経費の内容</span><input type="text" required maxLength={200} value={name} onChange={e => setName(e.target.value)} placeholder="梱包資材、家賃など" /></label>
        <label className="field"><span>経費の金額（円・返金はマイナス）</span><input type="number" required step={1} value={amount} onChange={e => setAmount(e.target.value)} /></label>
        <label className="field"><span>支払いカード</span><select value={card} onChange={e => setCard(e.target.value)}><option value="">未指定</option>{cards.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        <label className="field"><span>経費の担当者</span><select value={staffId} onChange={e => setStaffId(e.target.value)}><option value="">未指定</option>{staff.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <label className="field"><span>経費のメモ</span><textarea value={memo} onChange={e => setMemo(e.target.value)} /></label>
        <button className="btn primary" type="submit">{busy ? '保存中…' : '経費を保存'}</button>
      </fieldset>
    </form>
    <h3 style={{ marginTop: 20 }}>最近の経費</h3>
    {recent.length === 0 ? <p className="sub">登録された経費はありません。</p> : <div className="scroll"><table><thead><tr><th>日付・内容</th><th className="num">金額</th></tr></thead><tbody>{recent.map(r => <tr key={r.id}><td>{r.incurred_on}<div>{r.category} / {r.name}</div></td><td className="num">{yen(r.amount)}</td></tr>)}</tbody></table></div>}
  </aside>;
}
