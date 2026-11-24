import { yen } from '@bussan/shared';
import { useEffect, useState } from 'react';
import { fetchAmazonPayoutSummary, type AmazonPayout, type AmazonPayoutSummary } from '../api';

const ACCOUNTS = ['Amazon1', 'Amazon2'] as const;
const FIRST_VISIBLE = 3;
const FEE_LABELS: Record<string, string> = {
  ShippingService: '配送ラベル代', Refund: '返金', ServiceFee: 'Amazonの料金', DebtRecovery: 'カード等での精算',
  Adjustment: '調整', Retrocharge: '調整',
};
const FEE_DESCRIPTIONS: Record<string, string> = {
  Subscription: '月額利用料', FBAPostInboundTransportation: 'FBA納品送料', DebtPayment: 'カード等での精算',
};

// 名字だけを出す（長部一輝 → 長部、石嶋俊紀 → 石嶋）。
const surname = (name: string) => name.replace(/\s/g, '').slice(0, 2);
const day = (value: string | null) => value ? new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric' }).format(new Date(value)) : '';
const signed = (value: number) => value < 0 ? `−${Math.abs(value).toLocaleString('ja-JP')}` : value.toLocaleString('ja-JP');

function PayoutBlock({ payout, owners, open }: { payout: AmazonPayout; owners: AmazonPayoutSummary['owners']; open: boolean }) {
  const matches = payout.total !== null && payout.total === payout.line_total;
  const date = day(payout.fund_transfer_date ?? payout.group_end);
  const amount = (code: string) => payout.lines.filter(line => line.owner_code === code).reduce((sum, line) => sum + (line.amount ?? 0), 0);
  const items = (code: string) => new Set(payout.lines
    .filter(line => line.owner_code === code && line.type === 'Shipment' && line.serial).map(line => line.serial)).size;
  return <section className="payout-request" aria-label={`${payout.account} ${date} の振込`}>
    <div className="payout-head">
      <span>{payout.account}{date && `　${date} 振込`}　{yen(payout.total)}</span>
      <span className={matches ? 'payout-match' : 'payout-mismatch'}>{matches ? '✓ 内訳と一致' : `内訳の合計 ${yen(payout.line_total)}`}</span>
    </div>
    <div className="dashboard-comparison">
      {owners.map(owner => <div className="dashboard-comparison-panel" key={owner.code}>
        <h4>{surname(owner.name)}</h4>
        <div className="kpi-value">{yen(amount(owner.code))} <span className="dashboard-kpi-count">{items(owner.code)} 点</span></div>
      </div>)}
    </div>
    <details className="payout-lines" open={open}>
      <summary>内訳</summary>
      <div className="scroll payout-table" tabIndex={0} role="region" aria-label={`${payout.account} ${date} の振込の内訳`}><table>
        <thead><tr><th scope="col">商品</th><th scope="col">担当者</th><th scope="col">販売先</th><th scope="col" className="num">振込額</th></tr></thead>
        <tbody>
          {payout.lines.map((line, index) => {
            const note = line.type === 'Shipment' ? null
              : FEE_DESCRIPTIONS[line.description ?? ''] ?? FEE_LABELS[line.type ?? ''] ?? line.description ?? line.type;
            const product = [line.serial, line.product].filter(Boolean).join(' ');
            const value = line.amount ?? 0;
            return <tr key={`${line.sku ?? ''}-${index}`}>
              <td>{product || note || '—'}{product && note ? `（${note}）` : ''}</td>
              <td>{line.owner_name ? surname(line.owner_name) : '—'}</td>
              <td>{payout.account}</td>
              <td className={`num${value < 0 ? ' payout-negative' : ''}`}>{signed(value)}</td>
            </tr>;
          })}
        </tbody>
      </table></div>
    </details>
  </section>;
}

export default function AmazonPayoutCard() {
  const [summary, setSummary] = useState<AmazonPayoutSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    let active = true;
    fetchAmazonPayoutSummary()
      .then(data => { if (active) setSummary(data); })
      .catch((e: unknown) => { if (active) setError(e instanceof Error ? e.message : 'Amazonの振込を読み込めませんでした。'); });
    return () => { active = false; };
  }, []);

  const payouts = summary?.payouts ?? [];
  const visible = showAll ? payouts : payouts.slice(0, FIRST_VISIBLE);
  const missing = ACCOUNTS.filter(account => summary && !payouts.some(payout => payout.account === account));

  return <div className="card payout-summary-card">
    <h3>Amazon振込（支払いリクエストごと）</h3>
    {error && <p className="error" role="alert">{error}</p>}
    {!error && !summary && <p className="muted">読み込み中…</p>}
    {summary && payouts.length === 0 && <p className="muted">まだ振込がありません。</p>}
    {visible.map((payout, index) => <PayoutBlock key={`${payout.account}-${payout.group_id}`} payout={payout} owners={summary?.owners ?? []} open={index === 0} />)}
    {payouts.length > FIRST_VISIBLE && <button type="button" className="btn ghost payout-more" onClick={() => setShowAll(value => !value)}>
      {showAll ? '新しい3件だけ表示' : `前の振込も表示（ほか${payouts.length - FIRST_VISIBLE}件）`}
    </button>}
    {missing.map(account => <p className="payout-na" key={account}>
      {account}：振込の明細を取得できていません{account === 'Amazon1' ? '（権限の設定待ち）' : ''}
    </p>)}
  </div>;
}
