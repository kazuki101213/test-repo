import { useEffect, useRef, useState, type FormEvent } from 'react';
import { yen } from '@bussan/shared';
import { fetchCards, saveExpenses } from '../api';
import { expenseCategories, monthlyExpenseDates, type ExpenseInput } from '../expenses';

export default function ExpensePanel({ onSaved, onBusyChange }: { onSaved: () => void; onBusyChange: (busy: boolean) => void }) {
  const [date, setDate] = useState(() => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10));
  const [category, setCategory] = useState<ExpenseInput['category']>('諸経費');
  const [bulk, setBulk] = useState(false);
  const [fromMonth, setFromMonth] = useState(date.slice(0, 7));
  const [toMonth, setToMonth] = useState(date.slice(0, 7));
  const [day, setDay] = useState('1');
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [card, setCard] = useState('');
  const [memo, setMemo] = useState('');
  const [cards, setCards] = useState<{ id: string; name: string }[]>([]);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const [busy, setBusy] = useState(false);
  const ids = useRef<string[]>([]);
  const saving = useRef(false);
  const recurring = category === '固定費' && bulk;
  let dates: string[] = [];
  let periodError = '';
  try { dates = recurring ? monthlyExpenseDates(fromMonth, toMonth, Number(day)) : [date]; }
  catch (e) { periodError = e instanceof Error ? e.message : String(e); }

  useEffect(() => {
    let active = true;
    fetchCards().then(c => { if (active) setCards(c); })
      .catch(e => { if (active) setError(e instanceof Error ? e.message : String(e)); });
    return () => { active = false; };
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (saving.current) return;
    saving.current = true; setBusy(true); onBusyChange(true); setError(''); setDone('');
    try {
      if (periodError) throw new Error(periodError);
      if (!amount.trim()) throw new Error('金額を入力してください。');
      const inputs: ExpenseInput[] = dates.map((incurred_on, i) => ({
        id: ids.current[i] ?? (ids.current[i] = crypto.randomUUID()),
        incurred_on, category, name: name.trim(), amount: Number(amount),
        card_id: card || null, staff_id: null, memo: memo.trim() || null,
      }));
      await saveExpenses(inputs);
      setDone(`${inputs.length}件・合計${yen(inputs.reduce((sum, input) => sum + input.amount, 0))}を保存しました。「経費一覧」で確認できます。`);
      ids.current = [];
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
        <label className="field"><span>経費の区分</span><select value={category} onChange={e => setCategory(e.target.value as ExpenseInput['category'])}>{expenseCategories.map(c => <option key={c}>{c}</option>)}</select></label>
        {category === '固定費' ? <label className="expense-bulk-switch"><input type="checkbox" checked={bulk} onChange={e => setBulk(e.target.checked)} />複数月を一括入力</label> : <label className="field"><span>経費の日付</span><input type="date" required value={date} onChange={e => setDate(e.target.value)} /></label>}
        {category === '固定費' && !recurring && <label className="field expense-wide"><span>経費の日付</span><input type="date" required value={date} onChange={e => setDate(e.target.value)} /></label>}
        {recurring && <>
          <label className="field"><span>開始月</span><input type="month" required value={fromMonth} onChange={e => setFromMonth(e.target.value)} /></label>
          <label className="field"><span>終了月</span><input type="month" required min={fromMonth} value={toMonth} onChange={e => setToMonth(e.target.value)} /></label>
          <label className="field"><span>毎月の計上日</span><input type="number" required min={1} max={31} step={1} value={day} onChange={e => setDay(e.target.value)} /></label>
          <p className="expense-hint">該当日がない月は月末に計上します。</p>
        </>}
        <label className="field expense-wide"><span>経費の内容</span><input type="text" required maxLength={200} value={name} onChange={e => setName(e.target.value)} placeholder="梱包資材、家賃など" /></label>
        <label className="field"><span>{recurring ? '1か月の金額（円）' : '金額（円・返金はマイナス）'}</span><input type="number" required step={1} value={amount} onChange={e => setAmount(e.target.value)} /></label>
        <label className="field"><span>支払いカード</span><select value={card} onChange={e => setCard(e.target.value)}><option value="">未指定</option>{cards.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        <label className="field expense-wide"><span>経費のメモ</span><textarea rows={2} value={memo} onChange={e => setMemo(e.target.value)} /></label>
        {recurring && <div className="expense-hint expense-wide" aria-live="polite">{periodError || `${dates.length}か月分・合計${yen(Number(amount || 0) * dates.length)}（指定期間のみ登録）`}</div>}
        <button className="btn primary expense-wide" type="submit" disabled={Boolean(periodError)}>{busy ? '保存中…' : recurring ? `${dates.length}か月分を一括保存` : '経費を保存'}</button>
      </fieldset>
    </form>
  </aside>;
}
