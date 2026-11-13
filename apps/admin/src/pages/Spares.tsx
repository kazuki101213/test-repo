import { spareSearchFields, matchesSpareSearch, type SpareSearchField } from '@bussan/shared';
import { staffDisplayName, deliveryStaffOptions, inventorySiteStyle } from '@bussan/shared';
import ColoredSelect from '../components/ColoredSelect';
import DateInput from '../components/DateInput';
import SpareLinks from '../components/SpareLinks';
import '../components/ExpenseSelection.css';
import './SpareSelection.css';
import {useTaskConfirmation} from '../components/TaskConfirmation';
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { PURCHASE_SOURCES, accountLabelFor, marketplaceAccountLabel, marketplaceSelectOptions, purchaseSourceFields, deleteSpareAccessories, fetchSpareAccessories, spareState, yen } from '@bussan/shared';
import type { SpareAccessory, Staff } from '@bussan/shared';
import { createSpareAccessory, findInventoryAccessoriesForSpare, findInventoryForSpare, fetchStaff, moveInventoryAccessoryToSpares, updateSpareAccessory } from '../api';
import type { SpareAccessoryField, SpareAccessoryInput, SpareInventoryAccessory } from '../api';

type SpareReferenceMode = 'remote' | 'body';
type SpareReferenceItem = NonNullable<Awaited<ReturnType<typeof findInventoryForSpare>>>;
const referenceSerial = (value: string) => value.trim().toLowerCase();
function spareErrorMessage(cause: unknown): string {
  if (typeof cause === 'string' && cause.trim()) return cause;
  if (cause && typeof cause === 'object' && 'message' in cause &&
    typeof cause.message === 'string' && cause.message.trim()) return cause.message;
  return '予備の情報を更新できませんでした。';
}

const emptyForm = (owner: Staff | null): SpareAccessoryInput => ({
  source_sku: null, owner_staff_id: owner?.id ?? null, owner_name: owner?.name ?? '',
  purchased_at: null, title: '', manufacturer: null, model_no: null, asin: null, cost_amount: 0, marketplace: null,
  marketplace_item_id: null, tracking_no: null, usage_note: null,
});

export default function Spares({ me }: { me: Staff }) {
  const confirmation = useTaskConfirmation();
  const [rows, setRows] = useState<SpareAccessory[]>([]);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [query, setQuery] = useState('');
  const [queryField, setQueryField] = useState<SpareSearchField>('title');
  const [ownerId, setOwnerId] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<SpareAccessoryInput>(() => emptyForm(me.role === 'purchaser' ? me : null));
  const [saving, setSaving] = useState(false);
  const [autofillBusy, setAutofillBusy] = useState(false);
  const [referenceMode, setReferenceMode] = useState<SpareReferenceMode>('body');
  const [referenceCandidates, setReferenceCandidates] = useState<SpareInventoryAccessory[]>([]);
  const [sourceItemId, setSourceItemId] = useState<string | null>(null);
  const [referenceFound, setReferenceFound] = useState(false);
  const [referenceMessage, setReferenceMessage] = useState('');
  const referenceLookup = useRef<{ key: string; ready: boolean } | null>(null);
  const saveLock = useRef(false);
  const [editFor, setEditFor] = useState<{ row: SpareAccessory; field: SpareAccessoryField } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [deleting, setDeleting] = useState(false);
  const deleteLock = useRef(false);
  const [message, setMessage] = useState('');

  const fetching = useRef(false);
  const reload = useCallback(async () => {
    if (fetching.current) return;
    fetching.current = true;
    setError('');
    try { setRows(await fetchSpareAccessories()); }
    catch (cause) { setError(spareErrorMessage(cause)); }
    finally { fetching.current = false; setLoading(false); }
  }, []);
  useEffect(() => {
    void reload(); fetchStaff().then(setStaff).catch(() => undefined);
    let lastAutomaticCheck = 0;
    const refresh = () => { if (document.visibilityState === 'visible' && Date.now() - lastAutomaticCheck >= 30000) { lastAutomaticCheck = Date.now(); void reload(); } };
    const timer = window.setInterval(refresh, 300000);
    window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', refresh);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, [reload]);

  const selectedOwner = staff.find(owner => owner.id === ownerId);
  const filtered = rows.filter(row => !row.used_for_item_id && matchesSpareSearch(row, queryField, query, ownerId, selectedOwner?.name));

  function changeOwner(id: string) {
    const owner = staff.find(row => row.id === id);
    setForm(current => ({ ...current, owner_staff_id: owner?.id ?? null, owner_name: owner?.name ?? (id ? current.owner_name : '') }));
  }

  function resetReference() {
    referenceLookup.current = null;
    setAutofillBusy(false);
    setSourceItemId(null);
    setReferenceFound(false);
    setReferenceCandidates([]);
    setReferenceMessage('');
    setError('');
    if (referenceFound) {
      setForm(current => ({ ...emptyForm(null), usage_note: current.usage_note, owner_staff_id: current.owner_staff_id, owner_name: current.owner_name }));
    }
  }

  function applyReference(item: SpareReferenceItem, mode: SpareReferenceMode) {
    setReferenceFound(true);
    setSourceItemId(mode === 'remote' ? item.id : null);
    setForm(current => ({
      ...current,
      source_sku: mode === 'remote' ? item.sku : null,
      owner_staff_id: item.deliverer_id ?? current.owner_staff_id,
      owner_name: item.deliverer_name ?? current.owner_name,
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
    setReferenceMessage(mode === 'remote' ? `${item.sku} の情報を反映しました。登録すると選んだ行が在庫から予備へ移動します。` : '');
  }

  async function autofillFromUsageSerial(serial: string, mode = referenceMode) {
    const match = referenceSerial(serial).match(/^(\d+)[a-z]*$/);
    if (!match) return;
    const key = `${mode}:${match[0]}`;
    if (referenceLookup.current?.key === key) return;
    const lookup = { key, ready: false };
    referenceLookup.current = lookup;
    setAutofillBusy(true);
    setReferenceMessage('');
    setError('');
    try {
      if (mode === 'remote') {
        const candidates = await findInventoryAccessoriesForSpare(match[0]);
        if (referenceLookup.current !== lookup) return;
        setReferenceCandidates(candidates);
        const [first, second] = candidates;
        if (first && !second) applyReference(first, mode);
        if (!candidates.length) setReferenceMessage(`通番号 ${match[0]} にリモコン行がありません。手入力で登録できます。`);
      } else {
        const item = await findInventoryForSpare(match[0]);
        if (referenceLookup.current !== lookup) return;
        if (item) applyReference(item, mode);
        else {
          setReferenceMessage(`通番号 ${match[0]} の本体が見つかりません。`);
          setForm(current => ({ ...current, title: 'リモコン', cost_amount: 0, source_sku: null }));
        }
      }
      lookup.ready = true;
    } catch (cause) {
      if (referenceLookup.current === lookup) {
        referenceLookup.current = null;
        setAutofillBusy(false);
        setError(spareErrorMessage(cause));
      }
    } finally {
      if (referenceLookup.current === lookup) setAutofillBusy(false);
    }
  }

  function changeReferenceMode(mode: SpareReferenceMode) {
    resetReference();
    setReferenceMode(mode);
    void autofillFromUsageSerial(form.usage_note ?? '', mode);
  }

  const needsAccessorySelection = referenceMode === 'remote' && referenceCandidates.length > 1 && !sourceItemId;

  async function add(event: FormEvent) {
    event.preventDefault();
    if (saveLock.current || autofillBusy || needsAccessorySelection) return;
    const serial = referenceSerial(form.usage_note ?? '');
    if (/^\d+[a-z]*$/.test(serial) &&
      (!referenceLookup.current?.ready || referenceLookup.current.key !== `${referenceMode}:${serial}`)) {
      await autofillFromUsageSerial(serial);
      return;
    }
    const source = referenceCandidates.find(item => item.id === sourceItemId);
    if (source && !window.confirm(`${source.title}（${source.marketplace_item_id ? `${source.marketplace_item_id} ／ ` : ''}${source.sku}）を在庫から予備へ移動します。続けますか？`)) return;
    saveLock.current = true;
    setSaving(true); setError('');
    try {
      if (!form.title.trim()) throw new Error('品名を入力してください。');
      if (!Number.isSafeInteger(form.cost_amount) || form.cost_amount < 0) throw new Error('仕入金額は0以上の整数で入力してください。');
      let input = { ...form, title: form.title.trim(), owner_name: form.owner_name?.trim() || null };
      if (referenceMode === 'body' && referenceFound) input = { ...input, title: 'リモコン', cost_amount: 0, source_sku: null };
      if (source) await moveInventoryAccessoryToSpares(source.id, { ...input, usage_note: serial });
      else await createSpareAccessory(input);
      resetReference();
      setForm(emptyForm(me.role === 'purchaser' ? me : null));
      await reload();
    } catch (cause) { setError(spareErrorMessage(cause)); }
    finally { saveLock.current = false; setSaving(false); }
  }

  const selectedRows = filtered.filter(row => selected.has(row.id));
  function askDelete() {
    if (me.role !== 'admin' || !selectedRows.length || deleting) return;
    let remaining = selectedRows.map(row => row.id);
    confirmation.ask(`予備 ${remaining.length}件の削除：${selectedRows.map(row => `${row.title}${row.source_sku ? `（${row.source_sku}）` : ''}`).join('、')}`, async () => {
      if (deleteLock.current) return;
      deleteLock.current = true; setDeleting(true); setError(''); setMessage('');
      try {
        const deleted = new Set(await deleteSpareAccessories(remaining));
        setRows(current => current.filter(row => !deleted.has(row.id)));
        setSelected(current => new Set([...current].filter(id => !deleted.has(id))));
        remaining = remaining.filter(id => !deleted.has(id));
        if (remaining.length) throw new Error(`${remaining.length}件は削除できません。すでに使用・割当済みか、削除権限がありません。`);
        setMessage('選択した予備を削除しました。');
      } finally { deleteLock.current = false; setDeleting(false); }
    }, 'この操作は取り消せません。');
  }
  const selection = (row: SpareAccessory) => me.role === 'admin' && <label className="expense-selection"><input type="checkbox" aria-label={`${row.title}${row.source_sku ? `（${row.source_sku}）` : ''}を選択`} checked={selected.has(row.id)} disabled={deleting || confirmation.pending} onChange={event => { const checked = event.target.checked; setSelected(current => { const next = new Set(current); if (checked) next.add(row.id); else next.delete(row.id); return next; }); }} /></label>;


  return <section className="dashboard-workspace with-expense registration-workspace spare-workspace">
    {confirmation.confirmation}
    <div className="card dashboard-content spare-list">
    <div className="spare-search spare-toolbar" role="group" aria-label="予備検索">
      <select aria-label="予備の検索項目" value={queryField} onChange={event => { setSelected(new Set()); setQueryField(event.target.value as SpareSearchField); setQuery(''); setOwnerId(''); }}>
        {spareSearchFields.map(field => <option key={field.value} value={field.value}>{field.label}</option>)}
      </select>
      {queryField === 'owner'
        ? <select aria-label="保管担当者で検索" value={ownerId} onChange={event => { setSelected(new Set()); setOwnerId(event.target.value); }}><option value="">全員</option>{deliveryStaffOptions(staff).map(owner => <option key={owner.id} value={owner.id}>{staffDisplayName(owner)}</option>)}</select>
        : <input type="search" aria-label="予備を検索" value={query} onChange={event => { setSelected(new Set()); setQuery(event.target.value); }} placeholder="検索" />}
      {me.role === 'admin' && <button type="button" className="btn" disabled={loading || deleting || confirmation.pending || !selectedRows.length} onClick={askDelete}>削除</button>}
    </div>


    {message && <p role="status">{message}</p>}
    {loading ? <p>読み込み中…</p> : <><div className="management-spare-mobile-list">{filtered.map(row => <div className="management-spare-card" key={row.id}>
      <div className="management-spare-heading"><strong><EditableSpare row={row} field="title" onEdit={setEditFor}>{row.title}</EditableSpare></strong> <span className="badge">{spareState(row)}</span></div>
      <div>保管担当者：<EditableSpare row={row} field="owner_name" onEdit={setEditFor}>{staffDisplayName(row.owner_name) || '未設定'}</EditableSpare></div>
      <div>メーカー：<EditableSpare row={row} field="manufacturer" onEdit={setEditFor}>{row.manufacturer || '未登録'}</EditableSpare></div>
      <div>購入日：<EditableSpare row={row} field="purchased_at" onEdit={setEditFor}>{row.purchased_at || '—'}</EditableSpare>　仕入金額：<EditableSpare row={row} field="cost_amount" onEdit={setEditFor}>{yen(row.cost_amount)}</EditableSpare></div>
      <div>SKU：<EditableSpare row={row} field="source_sku" onEdit={setEditFor}>{row.source_sku || '—'}</EditableSpare></div>
      <div>仕入先：<EditableSpare row={row} field="marketplace" onEdit={setEditFor}><span className="inventory-label" style={inventorySiteStyle(row.marketplace)}>{row.purchase_account_label || row.marketplace || '—'}</span></EditableSpare></div>
      <div>商品ID：<span className="reference-value"><EditableSpare row={row} field="marketplace_item_id" onEdit={setEditFor}>{row.marketplace_item_id || '—'}</EditableSpare><SpareLinks row={row} kind="product" /></span></div>
      <div>追跡番号：<EditableSpare row={row} field="tracking_no" onEdit={setEditFor}>{row.tracking_no || '—'}</EditableSpare></div>
      <div>利用記録：<span className="reference-value"><EditableSpare row={row} field="usage_note" onEdit={setEditFor}>{row.usage_note || '—'}</EditableSpare><SpareLinks row={row} kind="usage" /></span></div>
      {selection(row)}
    </div>)}</div>
    <div className="scroll spare-table-scroll"><table aria-label="予備一覧"><thead><tr>
      <th>保管担当者</th><th>品名</th><th>メーカー</th><th>購入日</th><th>仕入金額</th><th>仕入先</th><th>商品ID</th><th>追跡番号</th><th>利用記録</th>{me.role === 'admin' && <th aria-label="選択" />}
    </tr></thead><tbody>{filtered.map(row => <tr key={row.id}>
      <td><EditableSpare row={row} field="owner_name" onEdit={setEditFor}>{staffDisplayName(row.owner_name) || '未設定'}</EditableSpare></td>
      <td><EditableSpare row={row} field="title" onEdit={setEditFor}>{row.title}</EditableSpare></td>
      <td><EditableSpare row={row} field="manufacturer" onEdit={setEditFor}>{row.manufacturer || '—'}</EditableSpare></td>
      <td><EditableSpare row={row} field="purchased_at" onEdit={setEditFor}>{row.purchased_at || '—'}</EditableSpare></td>
      <td><EditableSpare row={row} field="cost_amount" onEdit={setEditFor}>{yen(row.cost_amount)}</EditableSpare></td>
      <td><EditableSpare row={row} field="marketplace" onEdit={setEditFor}><span className="inventory-label" style={inventorySiteStyle(row.marketplace)}>{row.purchase_account_label || row.marketplace || '—'}</span></EditableSpare></td>
      <td><span className="reference-value"><EditableSpare row={row} field="marketplace_item_id" onEdit={setEditFor}>{row.marketplace_item_id || '—'}</EditableSpare><SpareLinks row={row} kind="product" /></span></td>
      <td><EditableSpare row={row} field="tracking_no" onEdit={setEditFor}>{row.tracking_no || '—'}</EditableSpare></td>
      <td><span className="reference-value"><EditableSpare row={row} field="usage_note" onEdit={setEditFor}>{row.usage_note || (row.used_for_item_id ? '商品へ割当済み' : '—')}</EditableSpare><SpareLinks row={row} kind="usage" /></span></td>
      {me.role === 'admin' && <td>{selection(row)}</td>}
    </tr>)}</tbody></table></div></>}
    </div>
    {<form className="card spare-entry registration-entry registration-sidebar registration-form" onSubmit={event => void add(event)}>
      <div className="toolbar"><h2>予備登録</h2></div>
      <div className="grid cols2 registration-fields">
        <label className="field"><span>利用記録（通番号）</span><input value={form.usage_note ?? ''} disabled={saving} onChange={event => { const value = event.target.value; if (referenceSerial(value) !== referenceSerial(form.usage_note ?? '')) resetReference(); setForm(current => ({ ...current, usage_note: value || null })); }} onBlur={event => void autofillFromUsageSerial(event.target.value)} /></label>
        <label className="field"><span>購入日</span><DateInput className="registration-date" value={form.purchased_at ?? ''} onChange={event => setForm(current => ({ ...current, purchased_at: event.target.value || null }))} /></label>
        {me.role === 'admin' ? <label className="field"><span>保管担当者</span>
          <select value={form.owner_staff_id ?? ''} onChange={event => changeOwner(event.target.value)}><option value="">担当未設定</option>{deliveryStaffOptions(staff).map(person => <option key={person.id} value={person.id}>{staffDisplayName(person)}</option>)}</select>
        </label> : <label className="field"><span>保管担当者</span><input value={staffDisplayName(me)} readOnly /></label>}
        <label className="field"><span>品名</span><input required value={form.title} onChange={event => setForm(current => ({ ...current, title: event.target.value }))} /></label>
        <label className="field"><span>メーカー</span><input value={form.manufacturer ?? ''} onChange={event => setForm(current => ({ ...current, manufacturer: event.target.value || null }))} /></label>
        <label className="field"><span>ASIN</span><input value={form.asin ?? ''} onChange={event => setForm(current => ({ ...current, asin: event.target.value || null }))} /></label>
        <label className="field"><span>仕入金額</span><input type="number" min={0} step={1} value={form.cost_amount} onChange={event => setForm(current => ({ ...current, cost_amount: Number(event.target.value) }))} /></label>
        <label className="field"><span>仕入先</span><ColoredSelect value={marketplaceAccountLabel(form.purchase_account_id) || form.marketplace || ''} onChange={event => {
          const source = purchaseSourceFields(event.target.value);
          setForm(current => ({ ...current, ...source, marketplace: source.marketplace || null }));
        }}><option value="">未設定</option>{marketplaceSelectOptions(PURCHASE_SOURCES, marketplaceAccountLabel(form.purchase_account_id) || form.marketplace || '').map(value => <option key={value}>{value}</option>)}</ColoredSelect></label>
        <label className="field"><span>商品ID</span><input value={form.marketplace_item_id ?? ''} onChange={event => setForm(current => ({ ...current, marketplace_item_id: event.target.value || null }))} /></label>
        <label className="field"><span>追跡番号</span><input value={form.tracking_no ?? ''} onChange={event => setForm(current => ({ ...current, tracking_no: event.target.value || null }))} /></label>
        <label className="field registration-wide"><span>SKU</span><input value={form.source_sku ?? ''} onChange={event => setForm(current => ({ ...current, source_sku: event.target.value || null }))} /></label>
        <div role="group" aria-label="登録情報参照元" className="field registration-wide spare-reference-choices spare-reference-footer" style={{ border: 0, padding: 0, margin: 0 }}><div className="spare-reference-heading"><span>登録情報参照元</span><button className="btn primary" disabled={saving || autofillBusy || needsAccessorySelection}>{saving ? '登録中…' : autofillBusy ? '商品情報を確認中…' : '予備登録'}</button></div>
          <label className="row"><input type="radio" name="spare-reference-mode" checked={referenceMode === 'remote'} disabled={saving} onChange={() => changeReferenceMode('remote')} />リモコン情報参照</label>
          <label className="row"><input type="radio" name="spare-reference-mode" checked={referenceMode === 'body'} disabled={saving} onChange={() => changeReferenceMode('body')} />本体情報参照</label>
        </div>
        {referenceMode === 'remote' && referenceCandidates.length > 1 && <fieldset className="field registration-wide spare-reference-candidates" disabled={saving}>
          <legend>予備へ移す付属品を選択</legend>
          {referenceCandidates.map(item => <label className="spare-reference-candidate" key={item.id}>
            <input type="radio" name="spare-reference-item" value={item.id} checked={item.id === sourceItemId} onChange={() => applyReference(item, 'remote')} />
            <span><strong>{item.title}</strong> {item.marketplace_item_id || '商品ID未登録'}<small>{item.sku}</small></span>
          </label>)}
        </fieldset>}
        {autofillBusy && <p className="muted">通番号の商品情報を読み込み中…</p>}
        {referenceMessage && <p className="muted" role="status" style={{ gridColumn: '1 / -1' }}>{referenceMessage}</p>}
      </div>
      {error && <p className="error" role="alert">{error}</p>}

    </form>}
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
  const initial = field === 'marketplace' ? accountLabelFor(row.marketplace, row.purchase_account_label) || row.marketplace || '' : row[field] ?? '';
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
    } catch (cause) { setError(spareErrorMessage(cause)); setBusy(false); }
  }
  return <div className="inventory-edit-overlay" role="dialog" aria-modal="true" aria-label={`${labels[field]}を編集`}>
    <div className="card inventory-comment-panel"><h3>{labels[field]}を編集</h3>
      <label className="field"><span>{labels[field]}</span>
        {field === 'marketplace' ? <ColoredSelect autoFocus value={value} onChange={event => setValue(event.target.value)}><option value="">未設定</option>{marketplaceSelectOptions(PURCHASE_SOURCES, String(initial)).map(option => <option key={option}>{option}</option>)}</ColoredSelect>
          : date ? <DateInput autoFocus value={value} onChange={event => setValue(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void save(); }} />
            : <input autoFocus type={numeric ? 'number' : 'text'} min={numeric ? 0 : undefined} step={numeric ? 1 : undefined} value={value} onChange={event => setValue(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void save(); }} />}
      </label>
      {error && <div className="error" role="alert">{error}</div>}
      <div className="toolbar"><button className="btn primary" disabled={busy} onClick={() => void save()}>保存</button><button className="btn" disabled={busy} onClick={onClose}>閉じる</button></div>
    </div>
  </div>;
}
