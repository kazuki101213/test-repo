import { yen } from '@bussan/shared';
import { useEffect, useState } from 'react';
import { fetchAmazonPayoutSummary, type AmazonPayout, type AmazonPayoutSummary } from '../api';

const ACCOUNTS = ['Amazon1', 'Amazon2'] as const;
const FEE_LABELS: Record<string, string> = {
  ShippingService: '配送ラベル代', Refund: '返金', ServiceFee: 'Amazonの料金', DebtRecovery: 'カード等での精算',
  Adjustment: '調整', Retrocharge: '調整',
};
const FEE_DESCRIPTIONS: Record<string, string> = {
  Subscription: '月額利用料', FBAPostInboundTransportation: 'FBA納品送料', DebtPayment: 'カード等での精算',
};

// 名字だけを出す（長部一輝 → 長部、石嶋俊紀 → 石嶋）。
const surname = (name: string) => name.replace(/\s/g, '').slice(0, 2);
const day = (value: string | null) => value ? new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: 'numeric', day: 'numeric' }).format(new Date(value)) : '';
// プルダウンは横に並べるので短く（今年は月/日だけ）。
const shortDay = (value: string | null) => {
  if (!value) return '';
  const date = new Date(value), thisYear = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric' });
  const sameYear = thisYear.format(date) === thisYear.format(new Date());
  return new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', ...(sameYear ? {} : { year: 'numeric' }), month: 'numeric', day: 'numeric' }).format(date);
};
const clock = (value: string | null) => value ? new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : '';
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
  const [account, setAccount] = useState<string>('');
  const [groupId, setGroupId] = useState<string>('');

  useEffect(() => {
    let active = true;
    fetchAmazonPayoutSummary()
      .then(data => { if (active) setSummary(data); })
      .catch((e: unknown) => { if (active) setError(e instanceof Error ? e.message : 'Amazonの振込を読み込めませんでした。'); });
    return () => { active = false; };
  }, []);

  const payouts = summary?.payouts ?? [];
  // 最初は一番新しい振込のアカウントを選ぶ（振込は新しい順に届く）。
  const selectedAccount = account || payouts[0]?.account || 'Amazon2';
  const accountPayouts = payouts.filter(payout => payout.account === selectedAccount);
  const selected = accountPayouts.find(payout => payout.group_id === groupId) ?? accountPayouts[0];
  // 金額は出さない（2026-11-24 ユーザー指示）。同じ日に2回あるときだけ時刻で見分ける。
  const sameDay = (payout: AmazonPayout) => accountPayouts.filter(other =>
    shortDay(other.fund_transfer_date ?? other.group_end) === shortDay(payout.fund_transfer_date ?? payout.group_end)).length > 1;

  return <div className="card payout-summary-card">
    <h3>Amazon振込</h3>
    {error && <p className="error" role="alert">{error}</p>}
    {!error && !summary && <p className="muted">読み込み中…</p>}
    {summary && <>
      <div className="payout-selects">
        <label>販売先 <select value={selectedAccount} onChange={event => { setAccount(event.target.value); setGroupId(''); }}>
          {ACCOUNTS.map(name => <option key={name} value={name}>{name}</option>)}
        </select></label>
        <label>振込日 <select value={selected?.group_id ?? ''} disabled={!accountPayouts.length} onChange={event => setGroupId(event.target.value)}>
          {!accountPayouts.length && <option value="">—</option>}
          {accountPayouts.map(payout => <option key={payout.group_id} value={payout.group_id}>
            {shortDay(payout.fund_transfer_date ?? payout.group_end)}{sameDay(payout) ? ` ${clock(payout.fund_transfer_date ?? payout.group_end)}` : ''}
          </option>)}
        </select></label>
      </div>
      {selected
        ? <PayoutBlock key={`${selected.account}-${selected.group_id}`} payout={selected} owners={summary.owners} open />
        : <p className="payout-na">{selectedAccount}：振込の明細を取得できていません{selectedAccount === 'Amazon1' ? '（権限の設定待ち）' : ''}</p>}
    </>}
  </div>;
}
