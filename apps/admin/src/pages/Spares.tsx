import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { MARKETPLACES, fetchSpareAccessories, yen } from '@bussan/shared';
import type { SpareAccessory, Staff } from '@bussan/shared';
import { createSpareAccessory, findInventoryForSpare, fetchStaff, updateSpareAccessory } from '../api';
import type { SpareAccessoryField, SpareAccessoryInput } from '../api';

const emptyForm = (owner: Staff | null): SpareAccessoryInput => ({
  source_sku: null, owner_staff_id: owner?.id ?? null, owner_name: owner?.name ?? '',
  purchased_at: null, title: '', cost_amount: 0, marketplace: null,
  marketplace_item_id: null, tracking_no: null, usage_note: null,
});

export default function Spares({ me }: { me: Staff }) {
  const [rows, setRows] = useState<SpareAccessory[]>([]);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState<SpareAccessoryInput>(() => emptyForm(me.role === 'purchaser' ? me : null));
  const [saving, setSaving] = useState(false);
  const [autofillBusy, setAutofillBusy] = useState(false);
  const [editFor, setEditFor] = useState<{ row: SpareAccessory; field: SpareAccessoryField } | null>(null);

  const reload = useCallback(async () => {
    setError('');
    try { setRows(await fetchSpareAccessories()); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void reload(); fetchStaff().then(setStaff).catch(() => undefined); }, [reload]);

  const filtered = rows.filter(row => !row.used_for_item_id && [row.title, row.source_sku, row.owner_name, row.marketplace, row.marketplace_item_id, row.tracking_no, row.usage_note]
    .some(value => value?.toLocaleLowerCase().includes(query.toLocaleLowerCase())));

  function changeOwner(id: string) {
    const owner = staff.find(row => row.id === id);
    setForm(current => ({ ...current, owner_staff_id: owner?.id ?? null, owner_name: owner?.name ?? (id ? current.owner_name : '') }));
  }

  async function autofillFromUsageSerial(serial: string) {
    const match = serial.trim().match(/^\d+[a-z]*$/i);
    if (!match) return;
    setAutofillBusy(true);
    try {
      const item = await findInventoryForSpare(match[0]);
      if (!item) return;
      setForm(current => ({
        ...current,
        source_sku: item.sku,
        owner_staff_id: item.purchaser_id ?? current.owner_staff_id,
        owner_name: item.purchaser_name ?? current.owner_name,
        purchased_at: item.purchased_at,
        title: item.title,
        cost_amount: item.cost_amount,
        marketplace: item.marketplace,
        marketplace_item_id: item.marketplace_item_id,
        tracking_no: item.tracking_no,
      }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setAutofillBusy(false); }
  }

  async function add(event: FormEvent) {
    event.preventDefault(); setSaving(true); setError('');
    try {
      if (!form.title.trim()) throw new Error('品名を入力してください。');
      if (!Number.isSafeInteger(form.cost_amount) || form.cost_amount < 0) throw new Error('仕入金額は0以上の整数で入力してください。');
      const input = { ...form, title: form.title.trim(), owner_name: form.owner_name?.trim() || null };
      await createSpareAccessory(input);
      setForm(emptyForm(me.role === 'purchaser' ? me : null)); setAdding(false);
      await reload();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSaving(false); }
  }

  return <section className="card">
    <div className="toolbar"><h2 style={{ margin: 0 }}>予備一覧</h2><span style={{ flex: 1 }} />
      <button className="btn primary" aria-expanded={adding} onClick={() => { setAdding(open => !open); setError(''); }}>予備を追加</button>
    </div>
    {adding && <form className="card" onSubmit={event => void add(event)}>
      <h3>予備付属品を登録</h3>
      <div className="grid cols2">
        {me.role === 'admin' ? <label className="field"><span>保管担当</span>
          <select value={form.owner_staff_id ?? ''} onChange={event => changeOwner(event.target.value)}><option value="">担当未設定</option>{staff.map(person => <option key={person.id} value={person.id}>{person.name}</option>)}</select>
        </label> : <label className="field"><span>保管担当</span><input value={me.name} readOnly /></label>}
        <label className="field"><span>保管担当名</span><input value={form.owner_name ?? ''} onChange={event => setForm(current => ({ ...current, owner_name: event.target.value }))} /></label>
        <label className="field"><span>品名</span><input required value={form.title} onChange={event => setForm(current => ({ ...current, title: event.target.value }))} /></label>
        <label className="field"><span>購入日</span><input type="date" value={form.purchased_at ?? ''} onChange={event => setForm(current => ({ ...current, purchased_at: event.target.value || null }))} /></label>
        <label className="field"><span>仕入金額</span><input type="number" min={0} step={1} value={form.cost_amount} onChange={event => setForm(current => ({ ...current, cost_amount: Number(event.target.value) }))} /></label>
        <label className="field"><span>仕入先</span><select value={form.marketplace ?? ''} onChange={event => setForm(current => ({ ...current, marketplace: event.target.value || null }))}><option value="">未設定</option>{MARKETPLACES.map(value => <option key={value}>{value}</option>)}</select></label>
        <label className="field"><span>SKU</span><input value={form.source_sku ?? ''} onChange={event => setForm(current => ({ ...current, source_sku: event.target.value || null }))} /></label>
        <label className="field"><span>商品ID</span><input value={form.marketplace_item_id ?? ''} onChange={event => setForm(current => ({ ...current, marketplace_item_id: event.target.value || null }))} /></label>
        <label className="field"><span>追跡番号</span><input value={form.tracking_no ?? ''} onChange={event => setForm(current => ({ ...current, tracking_no: event.target.value || null }))} /></label>
        <label className="field"><span>利用記録（通番号を入力すると商品情報を反映）</span><input value={form.usage_note ?? ''} onChange={event => setForm(current => ({ ...current, usage_note: event.target.value || null }))} onBlur={event => void autofillFromUsageSerial(event.target.value)} /></label>
        {autofillBusy && <p className="muted">通番号の商品情報を読み込み中…</p>}
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="toolbar"><button className="btn primary" disabled={saving || autofillBusy}>{saving ? '登録中…' : autofillBusy ? '商品情報を確認中…' : '登録する'}</button><button type="button" className="btn" disabled={saving || autofillBusy} onClick={() => setAdding(false)}>閉じる</button></div>
    </form>}
    <label className="field"><span>検索</span><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="品名・担当者・商品ID" /></label>
    {error && !adding && <p className="error">{error}</p>}
    {loading ? <p>読み込み中…</p> : <div className="scroll"><table><thead><tr>
      <th>保管担当</th><th>品名</th><th>購入日</th><th>仕入金額</th><th>仕入先</th><th>SKU</th><th>商品ID</th><th>追跡番号</th><th>利用記録</th>
    </tr></thead><tbody>{filtered.map(row => <tr key={row.id}>
      <td><EditableSpare row={row} field="owner_name" onEdit={setEditFor}>{row.owner_name || '未設定'}</EditableSpare></td>
      <td><EditableSpare row={row} field="title" onEdit={setEditFor}>{row.title}</EditableSpare></td>
      <td><EditableSpare row={row} field="purchased_at" onEdit={setEditFor}>{row.purchased_at || '—'}</EditableSpare></td>
      <td><EditableSpare row={row} field="cost_amount" onEdit={setEditFor}>{yen(row.cost_amount)}</EditableSpare></td>
      <td><EditableSpare row={row} field="marketplace" onEdit={setEditFor}>{row.marketplace || '—'}</EditableSpare></td>
      <td><EditableSpare row={row} field="source_sku" onEdit={setEditFor}>{row.source_sku || '—'}</EditableSpare></td>
      <td><EditableSpare row={row} field="marketplace_item_id" onEdit={setEditFor}>{row.marketplace_item_id || '—'}</EditableSpare></td>
      <td><EditableSpare row={row} field="tracking_no" onEdit={setEditFor}>{row.tracking_no || '—'}</EditableSpare></td>
      <td><EditableSpare row={row} field="usage_note" onEdit={setEditFor}>{row.usage_note || (row.used_for_item_id ? '商品へ割当済み' : '—')}</EditableSpare></td>
    </tr>)}</tbody></table></div>}
    {editFor && <SpareFieldDialog row={editFor.row} field={editFor.field} onClose={() => setEditFor(null)} onSaved={async () => { setEditFor(null); await reload(); }} />}
  </section>;
}

function EditableSpare({ row, field, onEdit, children }: { row: SpareAccessory; field: SpareAccessoryField; onEdit: (value: { row: SpareAccessory; field: SpareAccessoryField }) => void; children: ReactNode }) {
  return <button type="button" className="expense-edit" title="クリックして編集" onClick={() => onEdit({ row, field })}>{children}</button>;
}

function SpareFieldDialog({ row, field, onClose, onSaved }: { row: SpareAccessory; field: SpareAccessoryField; onClose: () => void; onSaved: () => void | Promise<void> }) {
  const labels: Record<SpareAccessoryField, string> = {
    source_sku: 'SKU', owner_name: '保管担当', purchased_at: '購入日', title: '品名', cost_amount: '仕入金額',
    marketplace: '仕入先', marketplace_item_id: '商品ID', tracking_no: '追跡番号', usage_note: '利用記録',
  };
  const initial = row[field] ?? '';
  const [value, setValue] = useState(String(initial));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const date = field === 'purchased_at';
  const numeric = field === 'cost_amount';
  async function save() {
    setBusy(true); setError('');
    try {
      if (field === 'title' && !value.trim()) throw new Error('品名を入力してください。');
      if (numeric && (!Number.isSafeInteger(Number(value)) || Number(value) < 0)) throw new Error('仕入金額は0以上の整数で入力してください。');
      const nextValue = numeric ? Number(value) : value.trim() || null;
      await updateSpareAccessory(row.id, field, nextValue);
      await onSaved();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); setBusy(false); }
  }
  return <div className="inventory-edit-overlay" role="dialog" aria-modal="true" aria-label={`${labels[field]}を編集`}>
    <div className="card inventory-comment-panel"><h3>{labels[field]}を編集</h3>
      <label className="field"><span>{labels[field]}</span>
        {field === 'marketplace' ? <select autoFocus value={value} onChange={event => setValue(event.target.value)}><option value="">未設定</option>{MARKETPLACES.map(option => <option key={option}>{option}</option>)}</select>
          : <input autoFocus type={date ? 'date' : numeric ? 'number' : 'text'} min={numeric ? 0 : undefined} step={numeric ? 1 : undefined} value={value} onChange={event => setValue(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void save(); }} />}
      </label>
      {error && <div className="error" role="alert">{error}</div>}
      <div className="toolbar"><button className="btn primary" disabled={busy} onClick={() => void save()}>保存</button><button className="btn" disabled={busy} onClick={onClose}>閉じる</button></div>
    </div>
  </div>;
}
