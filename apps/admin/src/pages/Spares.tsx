import { staffDisplayName, deliveryStaffOptions } from '@bussan/shared';
import ColoredLabel from '../components/ColoredLabel';
import ColoredSelect from '../components/ColoredSelect';
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { MARKETPLACES, deleteSpareAccessory, fetchSpareAccessories, yen } from '@bussan/shared';
import type { SpareAccessory, Staff } from '@bussan/shared';
import { createSpareAccessory, findInventoryAccessoryForSpare, findInventoryForSpare, fetchStaff, moveInventoryAccessoryToSpares, updateSpareAccessory } from '../api';
import type { SpareAccessoryField, SpareAccessoryInput } from '../api';

const emptyForm = (owner: Staff | null): SpareAccessoryInput => ({
  source_sku: null, owner_staff_id: owner?.id ?? null, owner_name: owner?.name ?? '',
  purchased_at: null, title: '', manufacturer: null, model_no: null, asin: null, cost_amount: 0, marketplace: null,
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
  const [referenceMode, setReferenceMode] = useState<'remote' | 'body'>('body');
  const [sourceItemId, setSourceItemId] = useState<string | null>(null);
  const [referenceFound, setReferenceFound] = useState(false);
  const [referenceMessage, setReferenceMessage] = useState('');
  const [editFor, setEditFor] = useState<{ row: SpareAccessory; field: SpareAccessoryField } | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const fetching = useRef(false);
  const reload = useCallback(async () => {
    if (fetching.current) return;
    fetching.current = true;
    setError('');
    try { setRows(await fetchSpareAccessories()); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { fetching.current = false; setLoading(false); }
  }, []);
  useEffect(() => {
    void reload(); fetchStaff().then(setStaff).catch(() => undefined);
    const refresh = () => { if (document.visibilityState === 'visible') void reload(); };
    const timer = window.setInterval(refresh, 30000);
    window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', refresh);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, [reload]);

  const filtered = rows.filter(row => !row.used_for_item_id && [row.title, row.manufacturer, row.model_no, row.asin, row.source_sku, row.owner_name, row.marketplace, row.marketplace_item_id, row.tracking_no, row.usage_note]
    .some(value => value?.toLocaleLowerCase().includes(query.toLocaleLowerCase())));

  function changeOwner(id: string) {
    const owner = staff.find(row => row.id === id);
    setForm(current => ({ ...current, owner_staff_id: owner?.id ?? null, owner_name: owner?.name ?? (id ? current.owner_name : '') }));
  }

  async function autofillFromUsageSerial(serial: string, mode = referenceMode) {
    const match = serial.trim().match(/^(\d+)[a-z]*$/i);
    if (!match) return;
    setAutofillBusy(true);
    setSourceItemId(null);
    setReferenceFound(false);
    setReferenceMessage('商品情報を読み込み中…');
    try {
      const item = mode === 'remote'
        ? await findInventoryAccessoryForSpare(match[0])
        : await findInventoryForSpare(match[0]);
      if (!item) {
        setReferenceMessage(mode === 'remote' ? `通番号 ${match[1]} にリモコン行がありません。手入力で登録できます。` : `通番号 ${match[1]} の本体が見つかりません。`);
        setForm(current => mode === 'body' ? { ...current, title: 'リモコン', cost_amount: 0, source_sku: null } : current);
        return;
      }
      setReferenceFound(true);
      if (mode === 'remote') setSourceItemId(item.id);
      setForm(current => ({
        ...current,
        source_sku: mode === 'remote' ? item.sku : null,
        owner_staff_id: item.purchaser_id ?? current.owner_staff_id,
        owner_name: item.purchaser_name ?? current.owner_name,
        purchased_at: item.purchased_at,
        title: mode === 'remote' ? item.title : 'リモコン',
        cost_amount: mode === 'remote' ? item.cost_amount : 0,
        marketplace: item.marketplace,
        marketplace_item_id: item.marketplace_item_id,
        tracking_no: item.tracking_no,
        manufacturer: item.maker,
        model_no: item.model_no,
        asin: item.asin,
      }));
      setReferenceMessage(mode === 'remote' ? `${item.sku} のリモコン情報を反映します。登録後、在庫のこのリモコン行を削除します。` : `${item.sku} の本体情報を反映します（品名・金額・SKUを指定どおりに設定）。本体行は変更しません。`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setAutofillBusy(false); }
  }

  async function add(event: FormEvent) {
    event.preventDefault();
    if (referenceMode === 'remote' && sourceItemId && !window.confirm('このリモコン情報を予備へ登録し、在庫のリモコン行を削除します。続けますか？')) return;
    setSaving(true); setError('');
    try {
      if (!form.title.trim()) throw new Error('品名を入力してください。');
      if (!Number.isSafeInteger(form.cost_amount) || form.cost_amount < 0) throw new Error('仕入金額は0以上の整数で入力してください。');
      let input = { ...form, title: form.title.trim(), owner_name: form.owner_name?.trim() || null };
      if (referenceMode === 'body' && referenceFound) input = { ...input, title: 'リモコン', cost_amount: 0, source_sku: null };
      if (referenceMode === 'remote' && sourceItemId) await moveInventoryAccessoryToSpares(sourceItemId, input);
      else await createSpareAccessory(input);
      setForm(emptyForm(me.role === 'purchaser' ? me : null)); setAdding(false);
      setSourceItemId(null); setReferenceFound(false); setReferenceMessage('');
      await reload();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSaving(false); }
  }

  async function remove(row: SpareAccessory) {
    if (!window.confirm(`「${row.title}」${row.source_sku ? `（${row.source_sku}）` : ''}を予備から削除します。この操作は取り消せません。削除しますか？`)) return;
    setDeletingId(row.id); setError('');
    try {
      await deleteSpareAccessory(row.id);
      setRows(current => current.filter(item => item.id !== row.id));
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setDeletingId(null); }
  }

  return <section className="card">
    <div className="toolbar"><h2 style={{ margin: 0 }}>予備</h2><span style={{ flex: 1 }} />
      <button className="btn primary" aria-expanded={adding} onClick={() => { setAdding(open => !open); setError(''); }}>予備を追加</button>
    </div>
    {adding && <form className="card" onSubmit={event => void add(event)}>
      <h3>予備付属品を登録</h3>
      <div className="grid cols2">
        <label className="field"><span>利用記録（通番号）</span><input value={form.usage_note ?? ''} onChange={event => { setSourceItemId(null); setReferenceFound(false); setForm(current => ({ ...current, usage_note: event.target.value || null })); }} onBlur={event => void autofillFromUsageSerial(event.target.value)} /></label>
        <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}><legend>登録情報参照元</legend>
          <label className="row"><input type="radio" name="spare-reference-mode" checked={referenceMode === 'remote'} onChange={() => { setReferenceMode('remote'); void autofillFromUsageSerial(form.usage_note ?? '', 'remote'); }} />リモコン情報参照</label>
          <label className="row"><input type="radio" name="spare-reference-mode" checked={referenceMode === 'body'} onChange={() => { setReferenceMode('body'); void autofillFromUsageSerial(form.usage_note ?? '', 'body'); }} />本体情報参照</label>
        </fieldset>
        {me.role === 'admin' ? <label className="field"><span>保管担当者</span>
          <select value={form.owner_staff_id ?? ''} onChange={event => changeOwner(event.target.value)}><option value="">担当未設定</option>{deliveryStaffOptions(staff).map(person => <option key={person.id} value={person.id}>{staffDisplayName(person)}</option>)}</select>
        </label> : <label className="field"><span>保管担当者</span><input value={staffDisplayName(me)} readOnly /></label>}
        <label className="field"><span>保管担当者名</span><input value={form.owner_name ?? ''} onChange={event => setForm(current => ({ ...current, owner_name: event.target.value }))} /></label>
        <label className="field"><span>品名</span><input required value={form.title} onChange={event => setForm(current => ({ ...current, title: event.target.value }))} /></label>
        <label className="field"><span>メーカー</span><input value={form.manufacturer ?? ''} onChange={event => setForm(current => ({ ...current, manufacturer: event.target.value || null }))} /></label>
        <label className="field"><span>ASIN</span><input value={form.asin ?? ''} onChange={event => setForm(current => ({ ...current, asin: event.target.value || null }))} /></label>
        <label className="field"><span>購入日</span><input type="date" value={form.purchased_at ?? ''} onChange={event => setForm(current => ({ ...current, purchased_at: event.target.value || null }))} /></label>
        <label className="field"><span>仕入金額</span><input type="number" min={0} step={1} value={form.cost_amount} onChange={event => setForm(current => ({ ...current, cost_amount: Number(event.target.value) }))} /></label>
        <label className="field"><span>仕入先</span><ColoredSelect value={form.marketplace ?? ''} onChange={event => setForm(current => ({ ...current, marketplace: event.target.value || null }))}><option value="">未設定</option>{MARKETPLACES.map(value => <option key={value}>{value}</option>)}</ColoredSelect></label>
        <label className="field"><span>SKU</span><input value={form.source_sku ?? ''} onChange={event => setForm(current => ({ ...current, source_sku: event.target.value || null }))} /></label>
        <label className="field"><span>商品ID</span><input value={form.marketplace_item_id ?? ''} onChange={event => setForm(current => ({ ...current, marketplace_item_id: event.target.value || null }))} /></label>
        <label className="field"><span>追跡番号</span><input value={form.tracking_no ?? ''} onChange={event => setForm(current => ({ ...current, tracking_no: event.target.value || null }))} /></label>
        {autofillBusy && <p className="muted">通番号の商品情報を読み込み中…</p>}
        {referenceMessage && <p className="muted" role="status" style={{ gridColumn: '1 / -1' }}>{referenceMessage}</p>}
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="toolbar"><button className="btn primary" disabled={saving || autofillBusy}>{saving ? '登録中…' : autofillBusy ? '商品情報を確認中…' : '登録する'}</button><button type="button" className="btn" disabled={saving || autofillBusy} onClick={() => setAdding(false)}>閉じる</button></div>
    </form>}
    <label className="field"><span>検索</span><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="品名・担当者・商品ID" /></label>
    {error && !adding && <p className="error">{error}</p>}
    {loading ? <p>読み込み中…</p> : <div className="scroll"><table><thead><tr>
      <th>保管担当者</th><th>品名</th><th>メーカー</th><th>購入日</th><th>仕入金額</th><th>仕入先</th><th>商品ID</th><th>追跡番号</th><th>利用記録</th>{me.role === 'admin' && <th>操作</th>}
    </tr></thead><tbody>{filtered.map(row => <tr key={row.id}>
      <td><EditableSpare row={row} field="owner_name" onEdit={setEditFor}>{staffDisplayName(row.owner_name) || '未設定'}</EditableSpare></td>
      <td><EditableSpare row={row} field="title" onEdit={setEditFor}>{row.title}</EditableSpare></td>
      <td><EditableSpare row={row} field="manufacturer" onEdit={setEditFor}>{row.manufacturer || '—'}</EditableSpare></td>
      <td><EditableSpare row={row} field="purchased_at" onEdit={setEditFor}>{row.purchased_at || '—'}</EditableSpare></td>
      <td><EditableSpare row={row} field="cost_amount" onEdit={setEditFor}>{yen(row.cost_amount)}</EditableSpare></td>
      <td><EditableSpare row={row} field="marketplace" onEdit={setEditFor}><ColoredLabel value={row.marketplace || '—'} /></EditableSpare></td>
      <td><EditableSpare row={row} field="marketplace_item_id" onEdit={setEditFor}>{row.marketplace_item_id || '—'}</EditableSpare></td>
      <td><EditableSpare row={row} field="tracking_no" onEdit={setEditFor}>{row.tracking_no || '—'}</EditableSpare></td>
      <td><EditableSpare row={row} field="usage_note" onEdit={setEditFor}>{row.usage_note || (row.used_for_item_id ? '商品へ割当済み' : '—')}</EditableSpare></td>
      {me.role === 'admin' && <td><button type="button" className="btn danger spare-row-delete" disabled={deletingId !== null} onClick={() => void remove(row)}>{deletingId === row.id ? '削除中…' : '削除'}</button></td>}
    </tr>)}</tbody></table></div>}
    {editFor && <SpareFieldDialog row={editFor.row} field={editFor.field} onClose={() => setEditFor(null)} onSaved={async () => { setEditFor(null); await reload(); }} />}
  </section>;
}

function EditableSpare({ row, field, onEdit, children }: { row: SpareAccessory; field: SpareAccessoryField; onEdit: (value: { row: SpareAccessory; field: SpareAccessoryField }) => void; children: ReactNode }) {
  return <button type="button" className="expense-edit" title="クリックして編集" onClick={() => onEdit({ row, field })}>{children}</button>;
}

function SpareFieldDialog({ row, field, onClose, onSaved }: { row: SpareAccessory; field: SpareAccessoryField; onClose: () => void; onSaved: () => void | Promise<void> }) {
  const labels: Record<SpareAccessoryField, string> = {
    source_sku: 'SKU', owner_name: '保管担当者', purchased_at: '購入日', title: '品名', manufacturer: 'メーカー', model_no: '型番', asin: 'ASIN', cost_amount: '仕入金額',
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
        {field === 'marketplace' ? <ColoredSelect autoFocus value={value} onChange={event => setValue(event.target.value)}><option value="">未設定</option>{MARKETPLACES.map(option => <option key={option}>{option}</option>)}</ColoredSelect>
          : <input autoFocus type={date ? 'date' : numeric ? 'number' : 'text'} min={numeric ? 0 : undefined} step={numeric ? 1 : undefined} value={value} onChange={event => setValue(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void save(); }} />}
      </label>
      {error && <div className="error" role="alert">{error}</div>}
      <div className="toolbar"><button className="btn primary" disabled={busy} onClick={() => void save()}>保存</button><button className="btn" disabled={busy} onClick={onClose}>閉じる</button></div>
    </div>
  </div>;
}
