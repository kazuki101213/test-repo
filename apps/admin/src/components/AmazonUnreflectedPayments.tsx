import { useEffect, useState } from 'react';
import { fetchAmazonUnreflectedPayments, type AmazonUnreflectedPayment } from '../api';

const formatter = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 10 });

function displayAmount({ amount, currency }: AmazonUnreflectedPayment) {
  if (amount === null) return '金額不明';
  const value = formatter.format(Math.abs(amount));
  if (currency === 'JPY') return value + '円';
  return currency ? value + ' ' + currency : value;
}

export default function AmazonUnreflectedPayments() {
  const [rows, setRows] = useState<AmazonUnreflectedPayment[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    fetchAmazonUnreflectedPayments().then(result => {
      if (active) setRows(result);
    }).catch(cause => {
      if (active) setError(cause.message);
    });
    return () => { active = false; };
  }, []);

  return <section className="card expense-column amazon-unreflected" aria-labelledby="amazon-unreflected-title">
    <h3 id="amazon-unreflected-title">Amazonの未反映分</h3>
    {error ? <p className="error" role="alert">{error}</p> : rows === null ? <p role="status">読み込み中…</p>
      : rows.length === 0 ? <p className="sub">未反映の明細はありません。</p>
        : <ul className="amazon-unreflected-entries">{rows.map(row => <li key={row.id}>
          <div className="amazon-unreflected-meta"><time dateTime={row.date}>{row.date}</time><span>{row.account}</span></div>
          <div className="amazon-unreflected-entry">
            <div>{row.description}<div className="expense-hint">{row.kind}{row.partiallyReflected ? ' · 一部反映済み' : ''}</div></div>
            <strong>{row.partiallyReflected && <small className="expense-hint">明細総額</small>}{displayAmount(row)}</strong>
          </div>
        </li>)}</ul>}
  </section>;
}
