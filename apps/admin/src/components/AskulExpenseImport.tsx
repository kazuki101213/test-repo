import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { askulCsvMaxBytes, findAskulDeliveryAssignee, parseAskulExpenseReport, staffDisplayName, yen, type AskulExpenseInput } from '@bussan/shared';
import { fetchAskulDeliveryProfiles, fetchStaff, importAskulExpenses } from '../api';

export default function AskulExpenseImport({ onClose, onSaved }: {
  onClose: () => void;
  onSaved: (result: Awaited<ReturnType<typeof importAskulExpenses>>) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [rows, setRows] = useState<AskulExpenseInput[]>([]);
  const [assigneeNames, setAssigneeNames] = useState<Record<string, string> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const lock = useRef(false);

  useEffect(() => { dialog.current?.showModal(); }, []);

  async function selectFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    setRows([]);
    setAssigneeNames(null);
    setError('');
    if (!file || lock.current) return;
    lock.current = true;
    setBusy(true);
    try {
      if (!/\.csv$/i.test(file.name)) throw new Error('アスクルのCSVファイルを選択してください。');
      if (file.size > askulCsvMaxBytes) throw new Error('12 MB以内のCSVを選択してください。');
      const report = await parseAskulExpenseReport(await file.arrayBuffer());
      if (report.deliveryAddresses) {
        const [staff, profiles] = await Promise.all([fetchStaff(), fetchAskulDeliveryProfiles()]);
        const names = Object.fromEntries(staff.map(person => [person.id, staffDisplayName(person)]));
        const activeProfiles = profiles.filter(profile => Object.hasOwn(names, profile.staff_id));
        const addresses = report.deliveryAddresses;
        setAssigneeNames(names);
        setRows(report.rows.map((row, index) => ({
          ...row, staff_id: findAskulDeliveryAssignee(addresses[index] ?? '', activeProfiles),
        })));
      } else {
        setRows(report.rows);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  async function submit() {
    if (!rows.length || lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      onSaved(await importAskulExpenses(rows));
    } catch (cause) {
      setError((cause instanceof Error ? cause.message : String(cause)) + ' 同じCSVで再実行できます。');
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  return <dialog ref={dialog} className="expense-delete-confirmation" aria-label="アスクルCSV取り込み" onCancel={event => {
    event.preventDefault();
    if (!lock.current) onClose();
  }}>
    <h3>アスクルCSV取り込み</h3>
    <label className="field">
      <span>購入実績CSV</span>
      <input type="file" accept=".csv,text/csv" disabled={busy} onChange={event => void selectFile(event)} />
    </label>
    {error && <p className="error" role="alert">{error}</p>}
    {rows.length > 0 && <>
      <p data-askul-rows={rows.length} data-askul-total={rows.reduce((total, row) => total + row.amount, 0)}>{rows.length.toLocaleString()}行 ／ 変動費 ／ 税込合計 {yen(rows.reduce((total, row) => total + row.amount, 0))}</p>
      {assigneeNames && <p className="sub">担当者を照合 {rows.filter(row => row.staff_id).length}件 ／ 未特定 {rows.filter(row => !row.staff_id).length}件</p>}
      <ul>{rows.slice(0, 20).map(row => <li key={row.id}>{row.incurred_on}　{row.name}　{yen(row.amount)}
        {assigneeNames && <div className="expense-hint">担当者 {row.staff_id ? assigneeNames[row.staff_id] : '未特定'}</div>}
      </li>)}</ul>
      {rows.length > 20 && <p>ほか {(rows.length - 20).toLocaleString()}行</p>}
    </>}
    <div className="toolbar">
      <button type="button" className="btn primary" data-askul-submit disabled={busy || !rows.length} onClick={() => void submit()}>{busy ? '処理中…' : '取り込む'}</button>
      <button type="button" className="btn" disabled={busy} onClick={onClose}>閉じる</button>
    </div>
  </dialog>;
}
