import { useEffect, useRef, useState } from 'react';
import { yen } from '@bussan/shared';
import { deleteExpenses, fetchExpenses, fetchExpenseDrafts, fetchExpenseReimbursements, fetchExpenseStaffNames, importAskulExpenses, updateExpenseField, type ExpenseField } from '../api';
import type { ExpenseInput, ExpenseDraft, ExpenseReimbursement } from '../expenses';
import { expenseCategories, expenseCategoryLabel } from '../expenses';
import ExpensePanel from './ExpensePanel';
import AskulExpenseImport from './AskulExpenseImport';
import AskulMaterialAnalysis from './AskulMaterialAnalysis';
import './ExpenseSelection.css';

type ExpenseCategory = typeof expenseCategories[number];
const isAskulExpense = (row: ExpenseInput) => row.memo?.startsWith('アスクル ') === true;

function expenseContentLabel(row: ExpenseInput, staffNames: Record<string, string>) {
  const assignee = row.staff_id && staffNames[row.staff_id];
  return isAskulExpense(row) && assignee && row.name !== assignee && !row.name.startsWith(`${assignee} `)
    ? `${assignee} ${row.name}` : row.name;
}

function useExpenseStaffNames(needed: boolean) {
  const [names, setNames] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!needed) return;
    let active = true;
    fetchExpenseStaffNames().then(result => { if (active) setNames(result); }).catch(() => {});
    return () => { active = false; };
  }, [needed]);
  return names;
}

export function ExpenseTable({ rows }: { rows: ExpenseInput[] }) {
  const staffNames = useExpenseStaffNames(rows.some(row => row.staff_id));
  const showStaffColumn = rows.some(row => !isAskulExpense(row) && row.staff_id);
  return rows.length === 0 ? <p className="sub">該当する経費はありません。</p> : <div className="scroll expense-table"><table>
    <thead><tr><th>日付</th><th>区分</th><th>内容</th>{showStaffColumn && <th>担当者</th>}<th className="num">金額</th></tr></thead>
    <tbody>{rows.map(row => <tr key={row.id}><td>{row.incurred_on}</td><td>{expenseCategoryLabel(row.category)}</td><td className="detail-description">{expenseContentLabel(row, staffNames)}</td>{showStaffColumn && <td>{!isAskulExpense(row) && row.staff_id ? staffNames[row.staff_id] || '—' : '—'}</td>}<td className="num">{yen(row.amount)}</td></tr>)}</tbody>
  </table></div>;
}

export default function ExpenseList({ revision }: { revision: number }) {
  const [rows, setRows] = useState<ExpenseInput[]>([]);
  const [reimbursements, setReimbursements] = useState<ExpenseReimbursement[]>([]);
  const [reimbursementStatus, setReimbursementStatus] = useState<{ loading: boolean; error?: string }>({loading:true});
  const staffNames = useExpenseStaffNames(reimbursements.length > 0 || rows.some(row => row.staff_id));
  const [drafts, setDrafts] = useState<ExpenseDraft[]>([]);
  const [editing, setEditing] = useState<ExpenseInput | undefined>();
  const [draft, setDraft] = useState<ExpenseDraft | undefined>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [expenseBusy, setExpenseBusy] = useState(false);
  const [savedRevision, setSavedRevision] = useState(0);
  const [categoryFilter, setCategoryFilter] = useState<ExpenseCategory | ''>('');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [deletion, setDeletion] = useState<{ rows: ExpenseInput[]; requestId: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [message, setMessage] = useState('');
  const [askulImportOpen, setAskulImportOpen] = useState(false);
  const [materialAnalysisOpen, setMaterialAnalysisOpen] = useState(false);
  const [askulResult, setAskulResult] = useState<Awaited<ReturnType<typeof importAskulExpenses>> | null>(null);
  const deleteLock = useRef(false);
  async function removeSelected() {
    if (!deletion || deleteLock.current) return;
    deleteLock.current = true; setDeleting(true); setDeleteError('');
    try {
      const count = await deleteExpenses(deletion.rows, deletion.requestId);
      const ids = new Set(deletion.rows.map(row => row.id));
      setRows(current => current.filter(row => !ids.has(row.id)));
      setDrafts(current => current.filter(row => !ids.has(row.id)));
      setSelected(new Set()); setDeletion(null); setMessage(`${count}件の経費を削除しました。`);
      setSavedRevision(value => value + 1);
    } catch (cause) { setDeleteError(cause instanceof Error ? cause.message : String(cause)); }
    finally { deleteLock.current = false; setDeleting(false); }
  }
  const [fieldEdit, setFieldEdit] = useState<{ row: ExpenseInput; field: ExpenseField; value: string } | null>(null);
  async function saveField() {
    if (!fieldEdit) return;
    setExpenseBusy(true); setError('');
    try { await updateExpenseField(fieldEdit.row, fieldEdit.field, fieldEdit.value); setFieldEdit(null); setSavedRevision(value => value + 1); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setExpenseBusy(false); }
  }
  const editCell = (row: ExpenseInput, field: ExpenseField, label: string) => <button type="button" className="expense-edit" disabled={expenseBusy || !!deletion} onClick={() => { setFieldEdit({ row, field, value: field === 'category' ? expenseCategoryLabel(row.category) : String(row[field]) }); setError(''); }}>{label}</button>;
  useEffect(() => {
    let active = true;
    setLoading(true); setError('');
    Promise.all([fetchExpenses(), fetchExpenseDrafts()]).then(([data, pending]) => { if (active) { setRows(data); setDrafts(pending); setSelected(new Set()); } })
      .catch(e => { if (active) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (active) setLoading(false); });
    setReimbursementStatus({loading:true});
    fetchExpenseReimbursements().then(data => {
      if (active) { setReimbursements(data); setReimbursementStatus({loading:false}); }
    }).catch(e => {
      if (active) setReimbursementStatus({loading:false,error:e instanceof Error ? e.message : String(e)});
    });
    return () => { active = false; };
  }, [revision, savedRevision]);
  const search = query.trim().toLowerCase();
  const matchesSearch = (name: string) => name.toLowerCase().includes(search);
  const filtered = rows.filter(row => (!categoryFilter || categoryFilter === expenseCategoryLabel(row.category)) && matchesSearch(expenseContentLabel(row, staffNames)));
  const pending = drafts.filter(d => !rows.some(row => row.id === d.id || (expenseCategoryLabel(row.category) === d.category && row.incurred_on.slice(0, 7) === d.target_month.slice(0, 7) && row.name === d.name))
    && (!categoryFilter || categoryFilter === d.category) && matchesSearch(d.name));
  const visibleReimbursements = reimbursements.filter(row => (!categoryFilter || categoryFilter === row.category)
    && matchesSearch(`${row.description} ${staffNames[row.staff_id] ?? ''}`));
  const months = [...new Set([...filtered.map(row => row.incurred_on.slice(0, 7)), ...pending.map(row => row.target_month.slice(0, 7))])].sort().reverse();
  return <div className="dashboard-workspace with-expense registration-workspace">
    <section id="expense-list" className="card expense-list dashboard-content" aria-label="経費一覧">
    <div className="toolbar expense-search-toolbar">
      <div className="expense-search-actions">
        <button type="button" className="btn" disabled={expenseBusy || !!deletion} onClick={() => { setAskulResult(null); setAskulImportOpen(true); }}>アスクルCSV取り込み</button>
        <button type="button" className="btn" disabled={expenseBusy || !!deletion} onClick={() => setMaterialAnalysisOpen(true)}>資材の購入分析</button>
      </div>
      <select aria-label="経費区分で絞り込む" value={categoryFilter} disabled={!!deletion} onChange={e => {
        setCategoryFilter(e.currentTarget.value as ExpenseCategory | '');
        setSelected(new Set());
      }}>
        <option value="">すべて</option>
        {expenseCategories.map(category => <option key={category} value={category}>{category}</option>)}
      </select>
      <input aria-label="経費を検索" placeholder="検索" type="search" value={query} disabled={!!deletion} onChange={e => { setQuery(e.target.value); setSelected(new Set()); }} />
      <button type="button" className="btn" disabled={loading || expenseBusy || !!deletion || !selected.size} onClick={() => { setDeleteError(''); setMessage(''); setDeletion({ rows: filtered.filter(row => selected.has(row.id)).map(row => ({...row})), requestId: crypto.randomUUID() }); }}>削除</button>
    </div>
    {message && <p className="ok" role="status">{message}</p>}
    {askulResult && <p className="ok" role="status" data-askul-inserted={askulResult.inserted} data-askul-skipped={askulResult.skipped}>アスクルCSVから{askulResult.inserted}件を登録しました。登録済み{askulResult.skipped}件。{askulResult.assignedExisting > 0 && `登録済みの${askulResult.assignedExisting}件に担当者を設定しました。`}{askulResult.quantitiesAdded > 0 && `登録済みの${askulResult.quantitiesAdded}件に資材の購入数量を追加しました。`}</p>}
    {error ? <div className="error">{error}</div> : loading ? <p>読み込み中…</p> : <>
      <div className="expense-columns">
        <section className="expense-column" aria-label="経費">
          <header><h3>経費</h3><p>{filtered.length}件 · <strong>{yen(filtered.reduce((sum, row) => sum + row.amount, 0))}</strong></p></header>
          {months.length === 0 ? <p className="sub">該当する経費はありません。</p> : <ul className="expense-entries">{months.map(month => {
            const entries = filtered.filter(row => row.incurred_on.startsWith(month));
            const monthDrafts = pending.filter(row => row.target_month.startsWith(month));
            return <li key={month} className="expense-month-group"><h4>{month.replace('-', '年')}月 · {yen(entries.reduce((sum, row) => sum + row.amount, 0))}</h4><ul className="expense-entries">{entries.map(row => <li key={row.id}>
            <div className="expense-entry-top">
              <time dateTime={row.incurred_on}>{editCell(row, 'incurred_on', row.incurred_on)}</time>
              <label className="expense-selection"><input type="checkbox" aria-label={`${row.incurred_on} ${row.name}を選択`} checked={selected.has(row.id)} disabled={loading || expenseBusy || !!deletion} onChange={e => { const checked=e.target.checked; setSelected(current => { const next=new Set(current); checked ? next.add(row.id) : next.delete(row.id); return next; }); }} /></label>
            </div>
            <div className="expense-entry-name">{editCell(row, 'name', expenseContentLabel(row, staffNames))}</div>
            {!isAskulExpense(row) && row.staff_id && staffNames[row.staff_id] && <div className="expense-hint">担当者 {staffNames[row.staff_id]}</div>}
            <div className="expense-entry-bottom"><span className="expense-hint">{editCell(row, 'category', expenseCategoryLabel(row.category))}</span><strong>{editCell(row, 'amount', yen(row.amount))}</strong></div>
          </li>)}{monthDrafts.map(row => <li key={row.id}>
            <button className="expense-edit" disabled={expenseBusy} aria-label={`${row.name}の金額と日付を入力`} onClick={() => { setEditing(undefined); setDraft(row); }}>
              <div>{row.name}</div><span className="expense-hint">日付・金額の入力待ち</span>
            </button>
          </li>)}</ul></li>;
          })}</ul>}
        </section>
        <section className="expense-column" aria-label="立替支払い">
          <header><h3>立替支払い</h3><p>{visibleReimbursements.length}件</p></header>
          {reimbursementStatus.loading ? <p>読み込み中…</p>
            : reimbursementStatus.error ? <p className="error" role="alert">{reimbursementStatus.error}</p>
            : visibleReimbursements.length === 0 ? <p className="sub">該当する立替支払いはありません。</p>
            : <ul className="expense-entries">{visibleReimbursements.map(row => <li key={row.id}>
              <time dateTime={row.spent_on}>{row.spent_on}</time>
              <div>{row.description}</div>
              <div className="expense-hint">{staffNames[row.staff_id]}</div>
              <div className="expense-entry-bottom"><span className="expense-hint">{row.category ?? '区分未設定'}</span><strong>{yen(row.amount)}</strong></div>
              <div className="expense-hint">{row.included_in_expense ? '経費に計上済み' : row.approved ? '承認済み' : '未承認'}</div>
            </li>)}</ul>}
        </section>
      </div>
    </>}
  </section>
  {<ExpensePanel key={editing?.id ?? draft?.id ?? 'new'} initial={editing} template={draft ? { ...draft, month: draft.target_month.slice(0, 7) } : undefined} onSaved={() => setSavedRevision(value => value + 1)} onBusyChange={setExpenseBusy} onClose={draft ? () => { if (expenseBusy) return; setEditing(undefined); setDraft(undefined); } : undefined} />}
  {fieldEdit && <div className="inventory-edit-overlay" role="dialog" aria-modal="true" aria-label="経費の項目を編集"><div className="card inventory-comment-panel">
    <h3>{{ incurred_on: '日付', category: '区分', name: '内容', amount: '金額' }[fieldEdit.field]}を編集</h3>
    <label className="field"><span>{fieldEdit.row.name}</span>{fieldEdit.field === 'category' ? <select value={fieldEdit.value} onChange={e => setFieldEdit(current => current && { ...current, value: e.target.value })}>{expenseCategories.map(value => <option key={value} value={value}>{value}</option>)}</select>
      : <input autoFocus type={fieldEdit.field === 'incurred_on' ? 'date' : fieldEdit.field === 'amount' ? 'number' : 'text'} value={fieldEdit.value} onChange={e => setFieldEdit(current => current && { ...current, value: e.target.value })} onKeyDown={e => { if (e.key === 'Enter') void saveField(); }} />}</label>
    {error && <div className="error" role="alert">{error}</div>}
    <div className="toolbar"><button className="btn primary" disabled={expenseBusy} onClick={() => void saveField()}>保存</button><button className="btn" disabled={expenseBusy} onClick={() => setFieldEdit(null)}>閉じる</button></div>
  </div></div>}
  {askulImportOpen && <AskulExpenseImport onClose={() => setAskulImportOpen(false)} onSaved={result => {
    setAskulImportOpen(false);
    setQuery('');
    setCategoryFilter('');
    setAskulResult(result);
    setSavedRevision(value => value + 1);
  }} />}
  {materialAnalysisOpen && <AskulMaterialAnalysis onClose={() => setMaterialAnalysisOpen(false)} />}
  {deletion && <ExpenseDeleteConfirmation rows={deletion.rows} busy={deleting} error={deleteError} onDelete={() => void removeSelected()} onClose={() => { if (!deleteLock.current) setDeletion(null); }} />}
  </div>;
}

function ExpenseDeleteConfirmation({ rows, busy, error, onDelete, onClose }: { rows: ExpenseInput[]; busy: boolean; error: string; onDelete: () => void; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const element=dialog.current; element?.showModal(); return () => element?.close(); }, []);
  return <dialog ref={dialog} className="expense-delete-confirmation" aria-label="経費の削除" onCancel={e => { e.preventDefault(); if (!busy) onClose(); }}>
    <h3>経費の削除</h3><p>選択した{rows.length}件の経費を削除しますか？</p>
    <ul>{rows.map(row => <li key={row.id}>{row.incurred_on}　{row.name}　{yen(row.amount)}</li>)}</ul>
    <p>合計 {yen(rows.reduce((total,row) => total+row.amount,0))}</p>
    {rows.some(row => row.memo?.startsWith('納品請求書 ')) && <p>請求書の承認記録は変更されません。</p>}
    {error && <p className="error" role="alert">{error}</p>}
    <div className="toolbar"><button type="button" className="btn primary" disabled={busy} onClick={onDelete}>{busy ? '削除中…' : '削除'}</button><button type="button" className="btn" autoFocus disabled={busy} onClick={onClose}>閉じる</button></div>
  </dialog>;
}
