import { useEffect, useRef, useState } from 'react';
import { yen } from '@bussan/shared';
import { deleteExpenses, excludeExpenseReimbursements, fetchCards, fetchExpenses, fetchExpenseDrafts, fetchExpenseReimbursements, fetchExpenseStaffNames, importAskulExpenses, updateExpenseField, type ExpenseField } from '../api';
import type { ExpenseInput, ExpenseDraft, ExpenseReimbursement } from '../expenses';
import { expenseCategories, expenseCategoryLabel } from '../expenses';
import ExpensePanel from './ExpensePanel';
import AskulExpenseImport from './AskulExpenseImport';
import AskulMaterialAnalysis from './AskulMaterialAnalysis';
import AmazonUnreflectedPayments from './AmazonUnreflectedPayments';
import './ExpenseSelection.css';

type ExpenseCategory = typeof expenseCategories[number];
type SelectionAction =
  | { kind: 'expense'; rows: ExpenseInput[]; requestId: string }
  | { kind: 'reimbursement'; rows: ExpenseReimbursement[] };

function toggleSelection(current: Set<string>, id: string, checked: boolean) {
  const next = new Set(current);
  if (checked) next.add(id);
  else next.delete(id);
  return next;
}

const isAskulExpense = (row: ExpenseInput) => row.memo?.startsWith('アスクル ') === true;

function expenseContentLabel(row: ExpenseInput, staffNames: Record<string, string>) {
  const assignee = row.staff_id && staffNames[row.staff_id];
  return isAskulExpense(row) && assignee && row.name !== assignee && !row.name.startsWith(`${assignee} `)
    ? `${assignee} ${row.name}` : row.name;
}

function expenseMonthTitle(month: string, entries: readonly { amount: number }[]) {
  return `${month.replace('-', '年')}月 · ${yen(entries.reduce((sum, row) => sum + row.amount, 0))}`;
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
  const [cards, setCards] = useState<{ id: string; name: string }[]>([]);
  const [cardsError, setCardsError] = useState('');
  const [cardsLoading, setCardsLoading] = useState(true);
  const [cardsRevision, setCardsRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setCardsLoading(true); setCardsError('');
    fetchCards('expense').then(data => { if (active) setCards(data); })
      .catch(cause => { if (active) setCardsError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (active) setCardsLoading(false); });
    return () => { active = false; };
  }, [cardsRevision]);
  const paymentLabel = (row: ExpenseInput) => row.card_id
    ? cards.find(card => card.id === row.card_id)?.name || '支払い方法を確認'
    : '未指定';
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
  const [selectedReimbursements, setSelectedReimbursements] = useState<Set<string>>(() => new Set());
  const [selectionAction, setSelectionAction] = useState<SelectionAction | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [message, setMessage] = useState('');
  const [askulImportOpen, setAskulImportOpen] = useState(false);
  const [materialAnalysisOpen, setMaterialAnalysisOpen] = useState(false);
  const [askulResult, setAskulResult] = useState<Awaited<ReturnType<typeof importAskulExpenses>> | null>(null);
  const deleteLock = useRef(false);
  async function removeSelected() {
    if (!selectionAction || deleteLock.current) return;
    deleteLock.current = true; setDeleting(true); setDeleteError('');
    try {
      const ids = new Set(selectionAction.rows.map(row => row.id));
      if (selectionAction.kind === 'expense') {
        const count = await deleteExpenses(selectionAction.rows, selectionAction.requestId);
        setRows(current => current.filter(row => !ids.has(row.id)));
        setDrafts(current => current.filter(row => !ids.has(row.id)));
        setSelected(new Set());
        setMessage(`${count}件の経費を削除しました。`);
      } else {
        const count = await excludeExpenseReimbursements([...ids]);
        const remaining = ids.size - count;
        setSelectedReimbursements(new Set());
        setMessage(`${count}件の立替支払いを請求から除外しました。${remaining > 0 ? `${remaining}件は承認済み、または既に除外済みです。` : ''}`);
      }
      setSelectionAction(null);
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
  const editCell = (row: ExpenseInput, field: ExpenseField, label: string) => <button type="button" className="expense-edit" aria-label={field === 'card_id' ? row.name + 'の支払い方法を編集' : undefined} disabled={expenseBusy || !!selectionAction} onClick={() => { setFieldEdit({ row, field, value: field === 'category' ? expenseCategoryLabel(row.category) : String(row[field] ?? '') }); setError(''); }}>{label}</button>;
  useEffect(() => {
    let active = true;
    setLoading(true); setError('');
    Promise.all([fetchExpenses(), fetchExpenseDrafts()]).then(([data, pending]) => { if (active) { setRows(data); setDrafts(pending); setSelected(new Set()); } })
      .catch(e => { if (active) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (active) setLoading(false); });
    setReimbursementStatus({loading:true});
    fetchExpenseReimbursements().then(data => {
      if (active) { setReimbursements(data); setSelectedReimbursements(new Set()); setReimbursementStatus({loading:false}); }
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
  const selectedUnapproved = visibleReimbursements.filter(row => !row.approved && selectedReimbursements.has(row.id));
  const reimbursementsByMonth = new Map<string, ExpenseReimbursement[]>();
  for (const row of visibleReimbursements) {
    const month = row.spent_on.slice(0, 7);
    const entries = reimbursementsByMonth.get(month);
    if (entries) entries.push(row);
    else reimbursementsByMonth.set(month, [row]);
  }
  // 入力待ちの金額は、前月までの同じ経費の最新の金額を最初から入れておく（familia会費など金額が決まっているもの）。
  // 為替で毎月変わるもの（OPEN AI・ANTHROPICなど）は入れない：直近（最大3件）が2件以上あり、すべて同じ金額のときだけ入れる。
  const draftAmount = (d: ExpenseDraft) => {
    const recent = rows
      .filter(row => row.name === d.name && expenseCategoryLabel(row.category) === d.category && row.incurred_on < d.target_month)
      .sort((a, b) => b.incurred_on.localeCompare(a.incurred_on)).slice(0, 3);
    return recent.length >= 2 && recent.every(row => row.amount === recent[0].amount) ? recent[0].amount : null;
  };
  // 日付・金額の入力待ちは経費の列ではなく「未反映分」に出す（2026-11-22 ユーザー指定）。
  const months = [...new Set(filtered.map(row => row.incurred_on.slice(0, 7)))].sort().reverse();
  return <section id="expense-list" className="expense-workspace" aria-label="経費一覧">
    <div className="card expense-tools">
    <div className="toolbar expense-search-toolbar">
      <div className="expense-search-actions">
        <button type="button" className="btn" disabled={expenseBusy || !!selectionAction} onClick={() => { setAskulResult(null); setAskulImportOpen(true); }}>アスクルCSV取り込み</button>
        <button type="button" className="btn" disabled={expenseBusy || !!selectionAction} onClick={() => setMaterialAnalysisOpen(true)}>資材の購入分析</button>
      </div>
      <select aria-label="経費区分で絞り込む" value={categoryFilter} disabled={!!selectionAction} onChange={e => {
        setCategoryFilter(e.currentTarget.value as ExpenseCategory | '');
        setSelected(new Set());
        setSelectedReimbursements(new Set());
      }}>
        <option value="">すべて</option>
        {expenseCategories.map(category => <option key={category} value={category}>{category}</option>)}
      </select>
      <input aria-label="経費を検索" placeholder="検索" type="search" value={query} disabled={!!selectionAction} onChange={e => { setQuery(e.target.value); setSelected(new Set()); setSelectedReimbursements(new Set()); }} />
      <button type="button" className="btn" disabled={loading || expenseBusy || !!selectionAction || !selected.size} onClick={() => { setDeleteError(''); setMessage(''); setSelectionAction({ kind: 'expense', rows: filtered.filter(row => selected.has(row.id)).map(row => ({...row})), requestId: crypto.randomUUID() }); }}>削除</button>
    </div>
    {message && <p className="ok" role="status">{message}</p>}
    {askulResult && <p className="ok" role="status" data-askul-inserted={askulResult.inserted} data-askul-skipped={askulResult.skipped}>アスクルCSVから{askulResult.inserted}件を登録しました。登録済み{askulResult.skipped}件。{askulResult.assignedExisting > 0 && `登録済みの${askulResult.assignedExisting}件に担当者を設定しました。`}{askulResult.quantitiesAdded > 0 && `登録済みの${askulResult.quantitiesAdded}件に資材の購入数量を追加しました。`}</p>}
    </div>
        <section className="card expense-column expense-posted" aria-label="経費">
          <header><h3>経費</h3><p>{filtered.length}件 · <strong>{yen(filtered.reduce((sum, row) => sum + row.amount, 0))}</strong></p></header>
          {error ? <p className="error" role="alert">{error}</p> : loading ? <p>読み込み中…</p>
            : months.length === 0 ? <p className="sub">該当する経費はありません。</p> : <ul className="expense-entries">{months.map(month => {
            const entries = filtered.filter(row => row.incurred_on.startsWith(month));
            return <li key={month} className="expense-month-group"><h4>{expenseMonthTitle(month, entries)}</h4><ul className="expense-entries">{entries.map(row => <li key={row.id}>
            <div className="expense-entry-top">
              <time dateTime={row.incurred_on}>{editCell(row, 'incurred_on', row.incurred_on)}</time>
              <span className="expense-entry-payment" title={paymentLabel(row)}>{editCell(row, 'card_id', paymentLabel(row))}</span>
              <label className="expense-selection"><input type="checkbox" aria-label={`${row.incurred_on} ${row.name}を選択`} checked={selected.has(row.id)} disabled={loading || expenseBusy || !!selectionAction} onChange={e => { const checked = e.currentTarget.checked; setSelected(current => toggleSelection(current, row.id, checked)); }} /></label>
            </div>
            <div className="expense-entry-name">{editCell(row, 'name', expenseContentLabel(row, staffNames))}</div>
            {!isAskulExpense(row) && row.staff_id && staffNames[row.staff_id] && <div className="expense-hint">担当者 {staffNames[row.staff_id]}</div>}
            <div className="expense-entry-bottom"><span className="expense-hint">{editCell(row, 'category', expenseCategoryLabel(row.category))}</span><strong>{editCell(row, 'amount', yen(row.amount))}</strong></div>
          </li>)}</ul></li>;
          })}</ul>}
        </section>
        <section className="card expense-column expense-reimbursements" aria-label="立替支払い">
          <header>
            <div className="reimbursement-heading">
              <h3>立替支払い</h3>
              <button type="button" className="btn" disabled={reimbursementStatus.loading || expenseBusy || !!selectionAction || !selectedUnapproved.length} onClick={() => {
                setDeleteError('');
                setMessage('');
                setSelectionAction({ kind: 'reimbursement', rows: selectedUnapproved });
              }}>請求から除外</button>
            </div>
            <p>{visibleReimbursements.length}件</p>
          </header>
          {reimbursementStatus.loading ? <p>読み込み中…</p>
            : reimbursementStatus.error ? <p className="error" role="alert">{reimbursementStatus.error}</p>
            : visibleReimbursements.length === 0 ? <p className="sub">該当する立替支払いはありません。</p>
            : <ul className="expense-entries">{Array.from(reimbursementsByMonth, ([month, entries]) => <li key={month} className="expense-month-group">
              <h4>{expenseMonthTitle(month, entries)}</h4>
              <ul className="expense-entries">{entries.map(row => <li key={row.id}>
                <div className="expense-entry-top">
                  <time dateTime={row.spent_on}>{row.spent_on}</time>
                  <label className="expense-selection"><input
                    type="checkbox"
                    aria-label={`${row.spent_on} ${row.description}を選択`}
                    checked={selectedReimbursements.has(row.id)}
                    disabled={row.approved || expenseBusy || !!selectionAction}
                    onChange={e => {
                      const checked = e.currentTarget.checked;
                      setSelectedReimbursements(current => toggleSelection(current, row.id, checked));
                    }}
                  /></label>
                </div>
                <div>{row.description}</div>
                <div className="expense-hint">{staffNames[row.staff_id]}</div>
                <div className="expense-entry-bottom"><span className="expense-hint">{row.category ?? '区分未設定'}</span><strong>{yen(row.amount)}</strong></div>
                <div className="expense-hint">請求月 {row.billing_month.slice(0, 7).replace('-', '年')}月 · {row.included_in_expense ? '経費に計上済み' : row.approved ? '承認済み' : '未承認'}</div>
              </li>)}</ul>
            </li>)}</ul>}
        </section>
    <div className="expense-registration-column">
      <ExpensePanel key={editing?.id ?? draft?.id ?? 'new'} initial={editing} template={draft ? { ...draft, month: draft.target_month.slice(0, 7), amount: draftAmount(draft) } : undefined} onSaved={() => setSavedRevision(value => value + 1)} onBusyChange={setExpenseBusy} onClose={draft ? () => { if (expenseBusy) return; setEditing(undefined); setDraft(undefined); } : undefined} />
      <AmazonUnreflectedPayments onReflected={() => setSavedRevision(value => value + 1)} drafts={loading || error ? [] : pending.map(row => ({ ...row, amount: draftAmount(row) }))}draftsDisabled={expenseBusy} onDraft={row => { setEditing(undefined); setDraft(row); }} />
    </div>
  {fieldEdit && <div className="inventory-edit-overlay" role="dialog" aria-modal="true" aria-label="経費の項目を編集"><div className="card inventory-comment-panel">
    <h3>{{ incurred_on: '日付', category: '区分', name: '内容', amount: '金額', card_id: '支払い方法' }[fieldEdit.field]}を編集</h3>
    <label className="field"><span>{fieldEdit.row.name}</span>{fieldEdit.field === 'category' ? <select value={fieldEdit.value} onChange={e => setFieldEdit(current => current && { ...current, value: e.target.value })}>{expenseCategories.map(value => <option key={value} value={value}>{value}</option>)}</select>
      : fieldEdit.field === 'card_id' ? <select autoFocus aria-label="支払い方法" disabled={expenseBusy || cardsLoading} value={fieldEdit.value} onChange={e => setFieldEdit(current => current && { ...current, value: e.target.value })}><option value="">未指定</option>{fieldEdit.row.card_id && !cards.some(card => card.id === fieldEdit.row.card_id) && <option value={fieldEdit.row.card_id} disabled>登録済みの支払い方法</option>}{cards.map(card => <option key={card.id} value={card.id}>{card.name}</option>)}</select>
      : <input autoFocus type={fieldEdit.field === 'incurred_on' ? 'date' : fieldEdit.field === 'amount' ? 'number' : 'text'} value={fieldEdit.value} onChange={e => setFieldEdit(current => current && { ...current, value: e.target.value })} onKeyDown={e => { if (e.key === 'Enter') void saveField(); }} />}</label>
    {fieldEdit.field === 'card_id' && cardsError && <div className="error" role="alert">{cardsError}<button type="button" className="btn" disabled={cardsLoading} onClick={() => setCardsRevision(value => value + 1)}>支払い方法を再読み込み</button></div>}
    {error && <div className="error" role="alert">{error}</div>}
    <div className="toolbar"><button className="btn primary" disabled={expenseBusy || (fieldEdit.field === 'card_id' && (cardsLoading || !!cardsError))} onClick={() => void saveField()}>保存</button><button className="btn" disabled={expenseBusy} onClick={() => setFieldEdit(null)}>閉じる</button></div>
  </div></div>}
  {askulImportOpen && <AskulExpenseImport onClose={() => setAskulImportOpen(false)} onSaved={result => {
    setAskulImportOpen(false);
    setQuery('');
    setCategoryFilter('');
    setAskulResult(result);
    setSavedRevision(value => value + 1);
  }} />}
  {materialAnalysisOpen && <AskulMaterialAnalysis onClose={() => setMaterialAnalysisOpen(false)} />}
  {selectionAction && <ExpenseSelectionConfirmation action={selectionAction} busy={deleting} error={deleteError} onDelete={() => void removeSelected()} onClose={() => { if (!deleteLock.current) setSelectionAction(null); }} />}
  </section>;
}

function ExpenseSelectionConfirmation({ action, busy, error, onDelete, onClose }: { action: SelectionAction; busy: boolean; error: string; onDelete: () => void; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const element = dialog.current; element?.showModal(); return () => element?.close(); }, []);
  const excluding = action.kind === 'reimbursement';
  const title = excluding ? '立替支払いを請求から除外' : '経費の削除';
  const rows = excluding
    ? action.rows.map(row => ({ id: row.id, date: row.spent_on, name: row.description, amount: row.amount }))
    : action.rows.map(row => ({ id: row.id, date: row.incurred_on, name: row.name, amount: row.amount }));
  return <dialog ref={dialog} className="expense-delete-confirmation" aria-label={title} onCancel={e => { e.preventDefault(); if (!busy) onClose(); }}>
    <h3>{title}</h3>
    <p>選択した{rows.length}件{excluding ? 'の立替支払いを請求から除外しますか？' : 'の経費を削除しますか？'}</p>
    <ul>{rows.map(row => <li key={row.id}>{row.date}　{row.name}　{yen(row.amount)}</li>)}</ul>
    <p>合計 {yen(rows.reduce((total, row) => total + row.amount, 0))}</p>
    {action.kind === 'reimbursement' && <p>領収書は納品アプリの領収書明細に残ります。提出済みの請求書は再提出してください。</p>}
    {action.kind === 'expense' && action.rows.some(row => row.memo?.startsWith('納品請求書 ')) && <p>請求書の承認記録は変更されません。</p>}
    {error && <p className="error" role="alert">{error}</p>}
    <div className="toolbar">
      <button type="button" className="btn primary" disabled={busy} onClick={onDelete}>{busy ? '処理中…' : excluding ? '請求から除外' : '削除'}</button>
      <button type="button" className="btn" autoFocus disabled={busy} onClick={onClose}>閉じる</button>
    </div>
  </dialog>;
}
