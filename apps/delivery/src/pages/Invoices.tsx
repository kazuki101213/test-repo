import { useEffect, useState } from 'react';

import type { Staff, InvoiceReceipt } from '@bussan/shared';
import { staffDisplayName, deliveryStaffOptions, invoiceReceiptDetails, downloadInvoicePdf } from '@bussan/shared';
import DateInput from '../components/DateInput';
import { findInvoice, invoiceProfiles, prepareInvoice, submitDocuments, saveInvoiceProfile, japanToday, monthlyGrossProfit } from '../invoices';
import PackedSummary from '../components/PackedSummary';
import GrossProfitSummary from '../components/GrossProfitSummary';
import InvoiceSheet from '../components/InvoiceSheet';
import InvoiceReceipts from '../components/InvoiceReceipts';
import InvoiceExtraRows from '../components/InvoiceExtraRows';
import ReceiptSheets from '../components/ReceiptSheets';
import type { Invoice, InvoiceDetails, InvoiceLine, InvoiceProfile, InvoiceSnapshot } from '../invoices';
import '../invoice.css';

const errorText = (e: unknown) => e instanceof Error ? e.message : (e as { message?: string })?.message ?? '読み込みに失敗しました。';
const defaultAuctionDays = (month: string) => {
  const [year, monthNumber] = month.split('-').map(Number);
  if (!year || !monthNumber) return [] as string[];
  const days = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return Array.from({ length: days }, (_, index) => index + 1)
    .filter(day => [1, 3, 5].includes(new Date(Date.UTC(year, monthNumber - 1, day)).getUTCDay()))
    .map(day => `${month}-${String(day).padStart(2, '0')}`);
};
const auctionWorkdayLine = (date: string): InvoiceLine => ({ date, description: 'ヤフオク入札作業日', quantity: 1, unit_price: 4500 });

function ProfileEditor({ profile, onSave }: { profile: InvoiceProfile; onSave: (p: InvoiceProfile) => void }) {
  const [draft, setDraft] = useState(profile);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fields: [keyof InvoiceDetails, string][] = [
    ['issuer_name', '請求者名'], ['postal', '郵便番号'], ['address', '住所'], ['phone', '電話番号'], ['email', 'メールアドレス'],
    ['bank', '銀行名'], ['bank_code', '銀行コード'], ['branch', '支店名'], ['branch_code', '支店番号'],
    ['account_type', '口座種別'], ['account_number', '口座番号'], ['holder', '口座名義'], ['holder_kana', '口座名義カナ'], ['recipient', '請求先'],
  ];
  return <form className="card invoice-settings no-print" onSubmit={e => {
    e.preventDefault(); setBusy(true); setError('');
    void saveInvoiceProfile(draft).then(() => onSave(draft)).catch(e => setError(errorText(e))).finally(() => setBusy(false));
  }}>
    <h2>設定変更</h2>
    <div className="invoice-fields">
      <label>単価(円)<input type="number" min="0" max="1000000" step="1" required value={draft.unit_price} onChange={e => setDraft({ ...draft, unit_price: e.target.valueAsNumber })} /></label>
      {fields.filter(([key]) => key !== 'recipient').map(([key, label]) => <label key={key}>{label}{key === 'address'
        ? <textarea rows={2} maxLength={1000} value={draft.details[key]} onChange={e => setDraft({ ...draft, details: { ...draft.details, [key]: e.target.value } })} />
        : <input type="text" maxLength={1000} required={['issuer_name', 'bank', 'branch', 'account_number', 'holder'].includes(key)} value={draft.details[key]} onChange={e => setDraft({ ...draft, details: { ...draft.details, [key]: e.target.value } })} />}</label>)}
      <div className="invoice-recipient-save"><label>請求先<textarea rows={3} maxLength={1000} required value={draft.details.recipient} onChange={e => setDraft({ ...draft, details: { ...draft.details, recipient: e.target.value } })} /></label><button className="btn" disabled={busy}>保存</button></div>
    </div>
    {error && <div className="error" role="alert">{error}</div>}
  </form>;
}

export default function Invoices({ staff, onNavigationChange }: { staff: Staff; onNavigationChange: (state: 'busy' | 'dirty' | null) => void }) {
  const [profiles, setProfiles] = useState<InvoiceProfile[]>([]);
  const [staffId, setStaffId] = useState(staff.id);
  const [month, setMonth] = useState(japanToday().slice(0, 7));
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [snapshot, setSnapshot] = useState<InvoiceSnapshot | null>(null);
  const [extras, setExtras] = useState<InvoiceLine[]>([]);
  const [workdays, setWorkdays] = useState<string[]>([]);
  const [newWorkday, setNewWorkday] = useState('');
  const [grossProfit, setGrossProfit] = useState<number | null>(null);
  const [grossProfitLoading, setGrossProfitLoading] = useState(false);
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
  const [receiptBusy, setReceiptBusy] = useState(false);
  const [receiptRows, setReceiptRows] = useState<InvoiceReceipt[]>([]);
  const [pdfBusy, setPdfBusy] = useState(false);
  const profile = profiles.find(p => p.staff_id === staffId);
  const isIshikawa = profile?.details.issuer_name === '石川秀樹';

  useEffect(() => {
    onNavigationChange(busy || receiptBusy || pdfBusy ? 'busy' : dirty || settings ? 'dirty' : null);
    return () => onNavigationChange(null);
  }, [busy, receiptBusy, pdfBusy, dirty, settings, onNavigationChange]);

  useEffect(() => {
    let cancelled = false;
    setProfileLoading(true);
    void invoiceProfiles().then(allRows => {
      if (cancelled) return;
      const rows = staff.role === 'admin'
        ? deliveryStaffOptions(allRows.map(row => ({ ...row, name: row.details.issuer_name }))) : allRows;
      setProfiles(rows);
      if (!rows.some(p => p.staff_id === staff.id) && staff.role === 'admin' && rows[0]) setStaffId(rows[0].staff_id);
    }).catch(e => { if (!cancelled) setError(errorText(e)); }).finally(() => { if (!cancelled) setProfileLoading(false); });
    return () => { cancelled = true; };
  }, [staff.id, staff.role, reload]);

  useEffect(() => {
    let cancelled = false;
    setSnapshot(null); setInvoice(null); setReceiptRows([]); setExtras([]); setWorkdays([]); setNewWorkday(''); setGrossProfit(null); setNote(''); setDirty(false); setSettings(false); setMessage('');
    if (profileLoading) return;
    if (!profile || !month) { setLoading(false); return; }
    setLoading(true); setError('');
    void (async () => {
      const saved = await findInvoice(staffId, month);
      const preview = saved?.snapshot ?? await prepareInvoice(staffId, month);
      if (cancelled) return;
      const savedExtras = saved?.extras ?? [];
      const savedWorkdays = savedExtras.filter(line => line.description === 'ヤフオク入札作業日').map(line => line.date).filter((date): date is string => !!date);
      setInvoice(saved); setSnapshot(preview);
      setExtras(savedExtras.filter(line => line.description !== 'ヤフオク入札作業日' && line.description !== '粗利益連動調整'));
      setWorkdays(profile.details.issuer_name === '石川秀樹' ? (saved ? savedWorkdays : defaultAuctionDays(month)) : []);
      setNote(saved?.note ?? ''); setIssued(saved?.issued_on ?? japanToday());
    })().catch(e => { if (!cancelled) setError(errorText(e)); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [staffId, month, profileLoading, profile, reload]);

  useEffect(() => {
    if (!isIshikawa || !month) { setGrossProfit(null); return; }
    let cancelled = false;
    setGrossProfitLoading(true);
    void monthlyGrossProfit(staffId, month).then(value => { if (!cancelled) setGrossProfit(value.total); })
      .catch(e => { if (!cancelled) setError(errorText(e)); })
      .finally(() => { if (!cancelled) setGrossProfitLoading(false); });
    return () => { cancelled = true; };
  }, [staffId, month, isIshikawa, reload]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const leave = () => !dirty || window.confirm('保存していない変更を破棄しますか？');
  const addWorkday = () => {
    if (!newWorkday || !newWorkday.startsWith(`${month}-`) || workdays.includes(newWorkday)) return;
    setWorkdays(rows => [...rows, newWorkday].sort()); setNewWorkday(''); setDirty(true); setMessage('');
  };
  const editableExtras: InvoiceLine[] = [...extras, ...workdays.map(auctionWorkdayLine)];
  const auctionBasePay = workdays.length * 4500;
  const auctionProfitPay = Math.floor(Math.max(grossProfit ?? 0, 0) * 0.1);
  const auctionAdjustment = Math.max(0, auctionProfitPay - auctionBasePay);
  const previewExtras: InvoiceLine[] = [...editableExtras, ...(auctionAdjustment > 0 ? [{ date: null, description: '粗利益連動調整', quantity: 1, unit_price: auctionAdjustment }] : [])];
  const claimedReceipts = invoice?.approved_at
    ? (snapshot?.receipt_lines ?? []).map(row => ({ ...row, url: receiptRows.find(file => file.id === row.id)?.url ?? '' }))
    : invoiceReceiptDetails(receiptRows).sort((a, b) => (a.spent_on ?? '').localeCompare(b.spent_on ?? ''));
  async function printDocument() {
    if (pdfBusy || receiptBusy) return;
    setPdfBusy(true); setError('');
    try {
      // Let pending receipt layout finish before collecting the rendered pages.
      await new Promise<void>(resolve => window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve())));
      const selector = '.invoice-document .invoice-sheet,.receipt-document .receipt-summary-sheet,.receipt-document .receipt-photo-sheet';
      const elements = Array.from(document.querySelectorAll<HTMLElement>(selector));
      const files = claimedReceipts;
      if (files.some(file => !file.url)) throw new Error('請求書に含まれる添付を読み込めません。再読み込みしてください。');
      await downloadInvoicePdf(elements, files, `請求書_明細表_領収書_${month}.pdf`);
    } catch (e) { setError(errorText(e)); } finally { setPdfBusy(false); }
  }
  async function save() {
    setBusy(true); setError(''); setMessage('');
    try {
      const saved = await submitDocuments(staffId, month, issued, editableExtras, note, invoice, true, receiptRows.some(row => row.document_type !== 'invoice'));
      if (saved) {
        setInvoice(saved); setSnapshot(saved.snapshot);
        setExtras(saved.extras.filter(line => line.description !== 'ヤフオク入札作業日' && line.description !== '粗利益連動調整'));
        setWorkdays(saved.extras.filter(line => line.description === 'ヤフオク入札作業日').map(line => line.date).filter((date): date is string => !!date));
        setDirty(false);
      }
      setMessage('請求書を送信しました。');
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  }

  return <section className="invoices" data-print="invoice">
    <div className="card invoice-workspace">
    <div className="invoice-header no-print">
      <h2>請求書・領収書</h2>
      <div className="invoice-toolbar-scroll"><div className="invoice-toolbar">
        <label>担当者<select value={staffId} disabled={staff.role !== 'admin' || busy || receiptBusy || pdfBusy || loading} onChange={e => { if (leave()) setStaffId(e.target.value); }}>{profiles.map(p => <option key={p.staff_id} value={p.staff_id}>{staffDisplayName(p.details.issuer_name)}</option>)}</select></label>
        <label>請求月<input aria-label="請求対象月" type="month" required value={month} disabled={busy || receiptBusy || pdfBusy} onChange={e => { if (e.target.value && leave()) setMonth(e.target.value); }} /></label>
        <label>請求日<DateInput form="invoice-submit-form" required value={issued} disabled={busy || receiptBusy || pdfBusy || loading || settings || !!invoice?.approved_at} onChange={e => { setIssued(e.target.value); setDirty(true); }} /></label>
        {profile && <button type="button" className="btn ghost" disabled={busy || receiptBusy || pdfBusy || loading} onClick={() => { if (leave()) setSettings(s => !s); }}>設定変更</button>}
        {snapshot && <button type="button" className="btn" disabled={busy || receiptBusy || pdfBusy || settings} onClick={() => void printDocument()}>請求書PDF保存</button>}
        {snapshot && !invoice?.approved_at && <button type="submit" form="invoice-submit-form" className="btn" disabled={busy || receiptBusy || pdfBusy || loading || settings || (isIshikawa && grossProfitLoading) || (!snapshot.lines.length && !editableExtras.length && !claimedReceipts.length)}>請求書送信</button>}
      </div></div>
      {!loading && !profileLoading && !profile && <p>請求書の設定がありません。管理者に設定の登録を依頼してください。</p>}
      {pdfBusy && <p role="status">PDFを作成中…添付が多い場合は少し時間がかかります。</p>}
      {message && <p role="status">{message}</p>}
      {error && <div className="error" role="alert">{error}<button className="btn ghost" disabled={busy} onClick={() => { if (leave()) setReload(n => n + 1); }}>再読み込み</button></div>}
    </div>
    {settings && profile && <ProfileEditor key={staffId} profile={profile} onSave={p => { setProfiles(rows => rows.map(row => row.staff_id === p.staff_id ? p : row)); setSettings(false); }} />}
    {(loading || profileLoading) && <div className="empty no-print">読み込み中…</div>}
    {!loading && snapshot && !settings && <>
      <div className="invoice-documents">
      <div className="invoice-section">
      {invoice?.approved_at ? <div className="no-print"><p>承認済み・外注費に計上済みです。</p></div> :
      <form id="invoice-submit-form" className="no-print invoice-editor" onSubmit={e => { e.preventDefault(); void save(); }}>
        <h3>請求書明細</h3>
        {isIshikawa && <section className="invoice-auction-workdays">
          <h3>ヤフオク入札作業日</h3><p className="muted">対象月の月・水・金を初期設定しています。作業した日を個別に追加・削除できます。</p>
          <div className="row"><DateInput aria-label="作業日を追加" min={`${month}-01`} max={`${month}-${String(new Date(Date.UTC(Number(month.slice(0,4)), Number(month.slice(5,7)), 0)).getUTCDate()).padStart(2, '0')}`} value={newWorkday} onChange={e => setNewWorkday(e.target.value)} /><button type="button" className="btn ghost" disabled={busy || !newWorkday || workdays.includes(newWorkday)} onClick={addWorkday}>作業日を追加</button></div>
          {workdays.map(date => <div className="row" key={date}><span>{date}　¥4,500</span><button type="button" className="btn ghost" disabled={busy} onClick={() => { setWorkdays(rows => rows.filter(row => row !== date)); setDirty(true); }}>削除</button></div>)}
          <p>作業日分：¥{auctionBasePay.toLocaleString('ja-JP')}　粗利益の10%：{grossProfitLoading ? '計算中…' : `¥${auctionProfitPay.toLocaleString('ja-JP')}`}</p>
          {auctionAdjustment > 0 && <p className="error" role="alert">注意：粗利益の10%が作業日分を上回るため、粗利益連動調整 ¥{auctionAdjustment.toLocaleString('ja-JP')} を加算します。</p>}
        </section>}
        <InvoiceExtraRows key={`${staffId}/${month}`} lines={extras} disabled={busy || receiptBusy || pdfBusy} onChange={lines => { setExtras(lines); setDirty(true); setMessage(''); }} onDraftChange={() => setDirty(true)} />
        <label className="invoice-note-input">備考<textarea maxLength={2000} rows={2} value={note} disabled={busy} onChange={e => { setNote(e.target.value); setDirty(true); }} /></label>
      </form>}
      </div>
      <div className="receipt-section">
      <InvoiceReceipts key={`${staffId}/${month}`} staffId={staffId} month={month} approved={busy || pdfBusy || !!invoice?.approved_at} onBusyChange={setReceiptBusy} onRowsChange={setReceiptRows} onChanged={() => { setDirty(true); setMessage(''); }} />
      </div>
      </div>
      <div className="invoice-preview is-preview"><InvoiceSheet snapshot={snapshot} month={month} issued={issued} extras={invoice?.approved_at ? (snapshot.extras ?? []) : previewExtras} note={note} receipts={claimedReceipts} /></div>
      <ReceiptSheets rows={claimedReceipts} month={month} name={snapshot.profile.issuer_name} />
    </>}
    </div>
    <div className="no-print"><GrossProfitSummary staff={staff} /></div>
    <div className="card no-print"><PackedSummary staffId={staff.id} /></div>
  </section>;
}
