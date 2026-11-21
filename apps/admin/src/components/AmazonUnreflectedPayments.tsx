import { useEffect, useState } from 'react';
import { deleteExpenseDraft, fetchAmazonUnreflectedPayments, reviewAmazonPayment, type AmazonUnreflectedPayment } from '../api';
import type { ExpenseDraft } from '../expenses';

const formatter = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 10 });

function displayAmount({ amount, currency }: AmazonUnreflectedPayment) {
  if (amount === null) return '金額不明';
  const value = formatter.format(Math.abs(amount));
  if (currency === 'JPY') return value + '円';
  return currency ? value + ' ' + currency : value;
}

export default function AmazonUnreflectedPayments({ onReflected, drafts = [], draftsDisabled = false, onDraft }: {
  onReflected: () => void;
  drafts?: (ExpenseDraft & { amount?: number | null })[];
  draftsDisabled?: boolean;
  onDraft?: (row: ExpenseDraft) => void;
}) {
  const [rows, setRows] = useState<AmazonUnreflectedPayment[] | null>(null);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [message, setMessage] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setError('');
    fetchAmazonUnreflectedPayments().then(result => {
      if (active) setRows(result);
    }).catch(cause => {
      if (active) setError(cause.message);
    });
    return () => { active = false; };
  }, [revision]);

  async function review(row: AmazonUnreflectedPayment, decision: 'reflect' | 'delete') {
    if (busyId || (decision === 'delete' && !window.confirm(`「${row.description}」を未反映分から削除しますか？`))) return;
    setBusyId(row.id); setActionError(''); setMessage('');
    try {
      const result = await reviewAmazonPayment(row.id, decision);
      if (result.removed) setRows(current => current?.filter(item => item.id !== row.id) ?? null);
      if (result.expenseChanged) onReflected();
      setMessage(result.message);
      setRevision(value => value + 1);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : 'Amazonの明細を更新できませんでした。');
    } finally { setBusyId(null); }
  }

  async function removeDraft(row: ExpenseDraft) {
    if (busyId || !window.confirm(`「${row.name}」の入力待ちを未反映分から削除しますか？`)) return;
    setBusyId(row.id); setActionError(''); setMessage('');
    try {
      await deleteExpenseDraft(row.id);
      setMessage(`「${row.name}」の入力待ちを削除しました。`);
      onReflected();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : '入力待ちを削除できませんでした。');
    } finally { setBusyId(null); }
  }

  const amazonRows = rows ?? [];
  // 入力待ちとAmazonの明細は1つのリストにして、スクロールも1つにする（2026-11-22 ユーザー指定）。
  return <section className="card expense-column amazon-unreflected" aria-labelledby="amazon-unreflected-title">
    <h3 id="amazon-unreflected-title">未反映分</h3>
    {actionError && <p className="error" role="alert">{actionError}</p>}
    {message && <p role="status">{message}</p>}
    {error && <p className="error" role="alert">{error}</p>}
    {!error && rows === null && <p role="status">読み込み中…</p>}
    {drafts.length === 0 && rows !== null && amazonRows.length === 0 && !error ? <p className="sub">未反映の明細はありません。</p>
      : (drafts.length > 0 || amazonRows.length > 0) && <ul className="amazon-unreflected-entries">
        {drafts.map(row => <li key={'draft:' + row.id}>
          <div className="amazon-unreflected-meta"><span>{row.target_month.slice(0, 7).replace('-', '年')}月</span><span>入力待ち</span></div>
          <div className="amazon-unreflected-entry">
            <div>{row.name}<div className="expense-hint">区分 {row.category} · {row.amount != null ? '日付の入力待ち' : '日付・金額の入力待ち'}</div></div>
            <strong>{row.amount != null ? formatter.format(row.amount) + '円' : '金額未入力'}</strong>
          </div>
          <div className="amazon-unreflected-actions">
            <button type="button" className="btn primary" disabled={busyId !== null || draftsDisabled} aria-label={`${row.name}の金額と日付を入力`} onClick={() => onDraft?.(row)}>編集</button>
            <button type="button" className="btn" disabled={busyId !== null || draftsDisabled} onClick={() => void removeDraft(row)}>削除</button>
          </div>
        </li>)}
        {amazonRows.map(row => <li key={row.id}>
          <div className="amazon-unreflected-meta"><time dateTime={row.date}>{row.date}</time><span>{row.account}</span></div>
          <div className="amazon-unreflected-entry">
            <div>{row.description}<div className="expense-hint">区分 {row.kind}{row.partiallyReflected ? ' · 一部反映済み' : ''}</div></div>
            <strong>{row.partiallyReflected && <small className="expense-hint">明細総額</small>}{displayAmount(row)}</strong>
          </div>
          <div className="amazon-unreflected-actions">
            <button type="button" className="btn primary" disabled={busyId !== null || !row.canReflect} title={row.canReflect ? undefined : 'この区分は反映先の確認が必要です'} onClick={() => void review(row, 'reflect')}>反映</button>
            <button type="button" className="btn" disabled={busyId !== null} onClick={() => void review(row, 'delete')}>削除</button>
          </div>
        </li>)}
      </ul>}
  </section>;
}
