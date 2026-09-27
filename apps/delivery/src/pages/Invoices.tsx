import { useEffect, useState } from 'react';
import type { Staff } from '@bussan/shared';
import { findInvoice, invoiceProfiles, prepareInvoice, saveInvoice, saveInvoiceProfile, japanToday, yen } from '../invoices';
import type { Invoice, InvoiceDetails, InvoiceLine, InvoiceProfile, InvoiceSnapshot } from '../invoices';
import '../invoice.css';

const errorText = (e: unknown) => e instanceof Error ? e.message : (e as { message?: string })?.message ?? '読み込みに失敗しました。';

function ProfileEditor({ profile, onSave, onCancel }: { profile: InvoiceProfile; onSave: (p: InvoiceProfile) => void; onCancel: () => void }) {
  const [draft, setDraft] = useState(profile);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fields: [keyof InvoiceDetails, string][] = [
    ['issuer_name', '請求者名'], ['postal', '郵便番号'], ['address', '住所'], ['phone', '電話番号'], ['email', 'メールアドレス'],
    ['recipient', '請求先'], ['bank', '銀行名'], ['bank_code', '銀行コード'], ['branch', '支店名'], ['branch_code', '支店番号'],
    ['account_type', '口座種別'], ['account_number', '口座番号'], ['holder', '口座名義'], ['holder_kana', '口座名義カナ'],
  ];
  return <form className="card invoice-settings no-print" onSubmit={e => {
    e.preventDefault(); setBusy(true); setError('');
    void saveInvoiceProfile(draft).then(() => onSave(draft)).catch(e => setError(errorText(e))).finally(() => setBusy(false));
  }}>
    <h2>単価・振込先の設定</h2>
    <p className="muted">変更後に作成・再保存する請求書に反映します。保存済みの請求書は自動では変更しません。</p>
    <div className="invoice-fields">
      <label>納品1点の単価（円）<input type="number" min="0" max="1000000" step="1" required value={draft.unit_price} onChange={e => setDraft({ ...draft, unit_price: e.target.valueAsNumber })} /></label>
      {fields.map(([key, label]) => <label key={key}>{label}<textarea rows={key === 'address' || key === 'recipient' ? 3 : 1} maxLength={1000}
        required={['issuer_name', 'recipient', 'bank', 'branch', 'account_number', 'holder'].includes(key)} value={draft.details[key]}
        onChange={e => setDraft({ ...draft, details: { ...draft.details, [key]: e.target.value } })} /></label>)}
    </div>
    {error && <div className="error" role="alert">{error}</div>}
    <div className="row"><button className="btn" disabled={busy}>設定を保存</button><button type="button" className="btn ghost" disabled={busy} onClick={onCancel}>戻る</button></div>
  </form>;
}

function InvoiceSheet({ snapshot, month, issued, extras, note, saved }: {
  snapshot: InvoiceSnapshot; month: string; issued: string; extras: InvoiceLine[]; note: string; saved: Invoice | null;
}) {
  const p = snapshot.profile;
  const lines = [...snapshot.lines, ...extras];
  const subtotal = lines.reduce((sum, l) => sum + l.quantity * l.unit_price, 0);
  const tax = Math.floor(subtotal * snapshot.tax_percent / 100);
  return <article className="invoice-sheet">
    <header><h1>請求書</h1><div>{issued}<br />対象月：{month.replace('-', '年')}月{saved && <><br />No. {saved.id.slice(0, 8).toUpperCase()}</>}</div></header>
    <div className="invoice-parties"><div className="invoice-recipient">{p.recipient}</div><div>{p.issuer_name}<br />{p.postal}<br />{p.address}<br />TEL：{p.phone}<br />{p.email}</div></div>
    <p>下記のとおりご請求申し上げます。</p>
    <div className="invoice-total">ご請求金額 <strong>{yen(subtotal + tax)}</strong></div>
    <table><thead><tr><th>購入日／日付</th><th>内容</th><th>数量</th><th>単価</th><th>金額</th></tr></thead>
      <tbody>{lines.map((line, i) => <tr key={line.item_id ?? `extra-${i}`}><td>{line.date?.replaceAll('-', '/') ?? '—'}</td><td>{line.description}{line.lot_seq != null && <>（{line.lot_seq}）</>}</td><td>{line.quantity}</td><td>{yen(line.unit_price)}</td><td>{yen(line.quantity * line.unit_price)}</td></tr>)}</tbody>
      <tfoot>{tax > 0 && <tr><td colSpan={4}>消費税</td><td>{yen(tax)}</td></tr>}<tr><td colSpan={4}>合計</td><td>{yen(subtotal + tax)}</td></tr></tfoot>
    </table>
    {note && <p className="invoice-note">{note}</p>}
    <section className="invoice-bank"><h3>お振込先</h3><p>{p.bank}（{p.bank_code}） {p.branch}（{p.branch_code}）<br />{p.account_type} {p.account_number}<br />{p.holder}<br />{p.holder_kana}</p></section>
  </article>;
}

export default function Invoices({ staff, onNavigationChange }: { staff: Staff; onNavigationChange: (state: 'busy' | 'dirty' | null) => void }) {
  const [profiles, setProfiles] = useState<InvoiceProfile[]>([]);
  const [staffId, setStaffId] = useState(staff.id);
  const [month, setMonth] = useState(japanToday().slice(0, 7));
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [snapshot, setSnapshot] = useState<InvoiceSnapshot | null>(null);
  const [extras, setExtras] = useState<InvoiceLine[]>([]);
  const [issued, setIssued] = useState(japanToday());
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [profileLoading, setProfileLoading] = useState(true);
  const [settings, setSettings] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [reload, setReload] = useState(0);
  const profile = profiles.find(p => p.staff_id === staffId);

  useEffect(() => {
    onNavigationChange(busy ? 'busy' : dirty || settings ? 'dirty' : null);
    return () => onNavigationChange(null);
  }, [busy, dirty, settings, onNavigationChange]);

  useEffect(() => {
    let cancelled = false;
    setProfileLoading(true);
    void invoiceProfiles().then(rows => {
      if (cancelled) return;
      setProfiles(rows);
      if (!rows.some(p => p.staff_id === staff.id) && staff.role === 'admin' && rows[0]) setStaffId(rows[0].staff_id);
    }).catch(e => { if (!cancelled) setError(errorText(e)); }).finally(() => { if (!cancelled) setProfileLoading(false); });
    return () => { cancelled = true; };
  }, [staff.id, staff.role, reload]);

  useEffect(() => {
    let cancelled = false;
    setSnapshot(null); setInvoice(null); setExtras([]); setNote(''); setDirty(false); setSettings(false); setMessage('');
    if (profileLoading) return;
    if (!profile || !month) { setLoading(false); return; }
    setLoading(true); setError('');
    void (async () => {
      const saved = await findInvoice(staffId, month);
      const preview = saved?.snapshot ?? await prepareInvoice(staffId, month);
      if (cancelled) return;
      setInvoice(saved); setSnapshot(preview); setExtras(saved?.extras ?? []); setNote(saved?.note ?? ''); setIssued(saved?.issued_on ?? japanToday());
    })().catch(e => { if (!cancelled) setError(errorText(e)); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [staffId, month, profileLoading, profile, reload]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const leave = () => !dirty || window.confirm('保存していない変更を破棄しますか？');
  const changeExtra = (index: number, patch: Partial<InvoiceLine>) => { setExtras(rows => rows.map((row, i) => i === index ? { ...row, ...patch } : row)); setDirty(true); setMessage(''); };
  async function save() {
    setBusy(true); setError(''); setMessage('');
    try {
      const saved = await saveInvoice(staffId, month, issued, extras, note, invoice);
      setInvoice(saved); setSnapshot(saved.snapshot); setExtras(saved.extras); setDirty(false); setMessage('請求書を提出しました。管理者のタスクに追加され、承認後に経費へ反映されます。');
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  }

  return <section className="invoices">
    <div className="card no-print">
      <h2>請求書</h2>
      <div className="row">
        {staff.role === 'admin' && <label>担当者<select value={staffId} disabled={busy || loading} onChange={e => { if (leave()) setStaffId(e.target.value); }}>{profiles.map(p => <option key={p.staff_id} value={p.staff_id}>{p.details.issuer_name}</option>)}</select></label>}
        <label>梱包した月<input aria-label="請求対象月" type="month" required value={month} disabled={busy} onChange={e => { if (e.target.value && leave()) setMonth(e.target.value); }} /></label>
        {profile && <button className="btn ghost" disabled={busy || loading} onClick={() => { if (leave()) setSettings(s => !s); }}>単価・振込先</button>}
      </div>
      <p className="muted">その月に梱包した本体を集計します。同じ通番号は1点とし、明細には購入日を記載します。</p>
      {!loading && !profileLoading && !profile && <p>請求書の設定がありません。管理者に単価・振込先の登録を依頼してください。</p>}
      {message && <p role="status">{message}</p>}
      {error && <div className="error" role="alert">{error}<button className="btn ghost" disabled={busy} onClick={() => { if (leave()) setReload(n => n + 1); }}>再読み込み</button></div>}
    </div>
    {settings && profile && <ProfileEditor key={staffId} profile={profile} onCancel={() => setSettings(false)} onSave={p => { setProfiles(rows => rows.map(row => row.staff_id === p.staff_id ? p : row)); setSettings(false); }} />}
    {(loading || profileLoading) && <div className="empty no-print">読み込み中…</div>}
    {!loading && snapshot && !settings && <>
      {invoice?.approved_at ? <div className="card no-print"><p>承認済み・外注費に計上済みです。</p><button type="button" className="btn" onClick={() => window.print()}>PDF保存・印刷</button></div> :
      <form className="card no-print invoice-editor" onSubmit={e => { e.preventDefault(); void save(); }}>
        <div className="row"><label>請求日<input type="date" required value={issued} disabled={busy} onChange={e => { setIssued(e.target.value); setDirty(true); }} /></label><span className="muted">{invoice ? '承認待ち' : '未提出'}・納品 {snapshot.lines.length}点</span></div>
        <h3>送料・資材費・手当など</h3>
        {extras.map((line, i) => <div className="invoice-extra" key={i}>
          <label>日付<input type="date" value={line.date ?? ''} disabled={busy} onChange={e => changeExtra(i, { date: e.target.value || null })} /></label>
          <label>内容<input required maxLength={200} value={line.description} disabled={busy} list="invoice-extra-descriptions" onChange={e => changeExtra(i, { description: e.target.value })} /></label>
          <label>数量<input required type="number" min="1" max="100000" step="1" value={line.quantity} disabled={busy} onChange={e => changeExtra(i, { quantity: e.target.valueAsNumber })} /></label>
          <label>単価（円）<input required type="number" min="0" max="10000000" step="1" value={line.unit_price} disabled={busy} onChange={e => changeExtra(i, { unit_price: e.target.valueAsNumber })} /></label>
          <button type="button" className="btn ghost" aria-label={`${i + 1}行目を削除`} disabled={busy} onClick={() => { setExtras(rows => rows.filter((_, index) => index !== i)); setDirty(true); }}>削除</button>
        </div>)}
        <datalist id="invoice-extra-descriptions"><option value="送料" /><option value="資材費" /><option value="手当" /><option value="保管料" /></datalist>
        <button type="button" className="btn ghost" disabled={busy || extras.length >= 100} onClick={() => { setExtras(rows => [...rows, { date: null, description: '', quantity: 1, unit_price: 0 }]); setDirty(true); }}>明細を追加</button>
        <label className="invoice-note-input">備考<textarea maxLength={2000} rows={2} value={note} disabled={busy} onChange={e => { setNote(e.target.value); setDirty(true); }} /></label>
        <p className="muted">保存時に梱包実績と設定単価を再集計します。消費税の別途加算はありません。</p>
        <div className="row"><button className="btn" disabled={busy || (!snapshot.lines.length && !extras.length)}>{busy ? '提出中…' : invoice ? '修正して再提出' : '請求書を作成・提出'}</button><button type="button" className="btn ghost" disabled={busy || dirty || !invoice} onClick={() => window.print()}>PDF保存・印刷</button></div>
      </form>}
      <InvoiceSheet snapshot={snapshot} month={month} issued={issued} extras={extras} note={note} saved={invoice} />
    </>}
  </section>;
}
