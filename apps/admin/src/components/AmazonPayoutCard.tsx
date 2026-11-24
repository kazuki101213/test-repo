import { yen } from '@bussan/shared';
import { useEffect, useState } from 'react';
import { fetchAmazonPayoutSummary, type AmazonPayoutSummary } from '../api';

const ACCOUNTS = ['Amazon1', 'Amazon2'] as const;
const FEE_LABELS: Record<string, string> = {
  ShippingService: '配送ラベル代', Refund: '返金', ServiceFee: 'Amazonの料金', DebtRecovery: '残高不足分の精算',
  Adjustment: '調整', Retrocharge: '調整',
};

// 名字だけを出す（長部一輝 → 長部、石嶋俊紀 → 石嶋）。
const surname = (name: string) => name.replace(/\s/g, '').slice(0, 2);
const day = (value: string | null) => value ? new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric' }).format(new Date(value)) : '';

export default function AmazonPayoutCard() {
  const [summary, setSummary] = useState<AmazonPayoutSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetchAmazonPayoutSummary()
      .then(data => { if (active) setSummary(data); })
      .catch((e: unknown) => { if (active) setError(e instanceof Error ? e.message : 'Amazonの振込を読み込めませんでした。'); });
    return () => { active = false; };
  }, []);

  const owners = summary?.owners ?? [];
  const payouts = summary?.payouts ?? [];
  const byAccount = new Map(payouts.map(payout => [payout.account, payout]));
  const ownerAmount = (code: string, account?: string) => payouts
    .filter(payout => !account || payout.account === account)
    .flatMap(payout => payout.lines)
    .filter(line => line.owner_code === code)
    .reduce((sum, line) => sum + (line.amount ?? 0), 0);
  const ownerItems = (code: string) => new Set(payouts.flatMap(payout => payout.lines)
    .filter(line => line.owner_code === code && line.type === 'Shipment' && line.serial)
    .map(line => line.serial)).size;

  return <div className="card payout-summary-card">
    <h3>Amazon振込（最新）</h3>
    {error && <p className="error" role="alert">{error}</p>}
    {!error && !summary && <p className="muted">読み込み中…</p>}
    {summary && <>
      <div className="dashboard-comparison">
        {owners.map(owner => <div className="dashboard-comparison-panel" key={owner.code}>
          <h4>{surname(owner.name)}</h4>
          <div className="kpi-label">振込額</div>
          <div className="kpi-value">{yen(ownerAmount(owner.code))} <span className="dashboard-kpi-count">{ownerItems(owner.code)} 点</span></div>
          {ACCOUNTS.map(account => <div className="payout-account" key={account}>
            <span>{account}</span><b>{byAccount.has(account) ? yen(ownerAmount(owner.code, account)) : '—'}</b>
          </div>)}
        </div>)}
      </div>
      <details className="payout-lines" open>
        <summary>内訳</summary>
        {payouts.map(payout => {
          const matches = payout.total !== null && payout.total === payout.line_total;
          const date = day(payout.fund_transfer_date ?? payout.group_end);
          return <div key={payout.account}>
            <div className="payout-head">
              <span>{payout.account}{date && `　${date} 振込`}　{yen(payout.total)}</span>
              <span className={matches ? 'payout-match' : 'payout-mismatch'}>{matches ? '✓ 内訳と一致' : `内訳の合計 ${yen(payout.line_total)}`}</span>
            </div>
            <div className="scroll payout-table" tabIndex={0} role="region" aria-label={`${payout.account}の振込の内訳`}><table>
              <thead><tr><th scope="col">商品</th><th scope="col">担当者</th><th scope="col">販売先</th><th scope="col" className="num">振込額</th></tr></thead>
              <tbody>
                {payout.lines.map((line, index) => {
                  const note = line.type !== 'Shipment' ? FEE_LABELS[line.type ?? ''] ?? line.description ?? line.type : null;
                  const product = [line.serial, line.product].filter(Boolean).join(' ');
                  return <tr key={`${line.sku ?? ''}-${index}`}>
                    <td>{product || note || '—'}{product && note ? `（${note}）` : ''}</td>
                    <td>{line.owner_name ? surname(line.owner_name) : '—'}</td>
                    <td>{payout.account}</td>
                    <td className={`num${(line.amount ?? 0) < 0 ? ' payout-negative' : ''}`}>{(line.amount ?? 0) < 0 ? `−${Math.abs(line.amount ?? 0).toLocaleString('ja-JP')}` : (line.amount ?? 0).toLocaleString('ja-JP')}</td>
                  </tr>;
                })}
              </tbody>
            </table></div>
          </div>;
        })}
        {ACCOUNTS.filter(account => !byAccount.has(account)).map(account => <p className="payout-na" key={account}>
          {account}：振込の明細を取得できていません{account === 'Amazon1' ? '（権限の設定待ち）' : ''}
        </p>)}
      </details>
    </>}
  </div>;
}
