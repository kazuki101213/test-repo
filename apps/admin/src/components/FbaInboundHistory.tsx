import { useCallback, useEffect, useMemo, useState } from 'react';
import { inventoryStatusStyle, inventoryStatusText, staffDisplayName } from '@bussan/shared';
import { fetchFbaInboundHistory } from '../api';
import {
  amazonShipmentName, fbaPlanState, fbaPlanStateLabels, fbaSummary, fbaTimeline, filterFbaPlans, receivedCount, tokyoDateTime,
  type FbaHistoryPlan, type FbaPlanState,
} from '../fbaInboundHistory';
import './fbaInboundHistory.css';

const stateTone: Record<FbaPlanState, string> = {
  draft: 'neutral', working: 'warn', waiting: 'warn', transit: 'warn', receiving: 'info', received: 'ok', cancelled: 'muted',
};
const shipmentsUrl = 'https://sellercentral.amazon.co.jp/manage/shipments';

export default function FbaInboundHistory() {
  const [plans, setPlans] = useState<FbaHistoryPlan[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [account, setAccount] = useState('');
  const [state, setState] = useState<FbaPlanState | ''>('');
  const [query, setQuery] = useState('');
  const [showCancelled, setShowCancelled] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try { setPlans(await fetchFbaInboundHistory()); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'FBA納品の履歴を読み込めませんでした。'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const accounts = useMemo(() => [...new Set(plans.map(plan => plan.account))].sort(), [plans]);
  const visible = useMemo(() => filterFbaPlans(plans, { account, state, query, showCancelled }), [plans, account, state, query, showCancelled]);
  const summary = useMemo(() => fbaSummary(plans), [plans]);
  const cancelledCount = useMemo(() => plans.filter(plan => plan.stage === 'cancelled').length, [plans]);

  return <section className="fba-history" aria-label="FBA納品の履歴">
    <div className="fba-history-summary">
      <div><span>下書き</span><strong>{summary.draft}</strong></div>
      <div><span>発送・受領待ち</span><strong>{summary.open}</strong></div>
      <div><span>受領済み（今月）</span><strong>{summary.receivedThisMonth}</strong></div>
      <div><span>納品した点数（今月）</span><strong>{summary.itemsThisMonth}</strong></div>
    </div>
    <div className="toolbar fba-history-toolbar">
      <select aria-label="FBAアカウント" value={account} onChange={event => setAccount(event.target.value)}>
        <option value="">すべてのアカウント</option>
        {accounts.map(value => <option key={value} value={value}>{value}</option>)}
      </select>
      <select aria-label="納品の状態" value={state} onChange={event => setState(event.target.value as FbaPlanState | '')}>
        <option value="">すべての状態</option>
        {(Object.keys(fbaPlanStateLabels) as FbaPlanState[]).map(value => <option key={value} value={value}>{fbaPlanStateLabels[value]}</option>)}
      </select>
      <input type="search" aria-label="納品を検索" placeholder="プラン名・出荷番号・型番・SKU" value={query} onChange={event => setQuery(event.target.value)} />
      <label className="fba-history-check"><input type="checkbox" checked={showCancelled} onChange={event => setShowCancelled(event.target.checked)} />取消プラン表示（{cancelledCount}件）</label>
      <button type="button" className="btn" disabled={loading} onClick={() => void load()}>再読み込み</button>
      <span className="sub" aria-live="polite">{loading ? '読み込み中…' : `${visible.length}件`}</span>
    </div>
    {error && <div className="error" role="alert">{error}</div>}
    {!loading && !error && visible.length === 0 && <p className="empty" role="status">該当するFBA納品はありません。</p>}
    {visible.length > 0 && <div className="fba-history-list" role="list">
      {visible.map(plan => {
        const planState = fbaPlanState(plan);
        const expanded = open === plan.id;
        const detailId = `fba-plan-${plan.id}`;
        const names = plan.shipments.map(shipment => amazonShipmentName(plan.dispatch_requested_at, shipment.warehouse) ?? [shipment.confirmation_id, shipment.warehouse].filter(Boolean).join(' '));
        const received = receivedCount(plan);
        return <div key={plan.id} className={`fba-history-plan${expanded ? ' open' : ''}${planState === 'cancelled' ? ' cancelled' : ''}`} role="listitem">
          <button type="button" className="fba-history-row" aria-expanded={expanded} aria-controls={detailId} onClick={() => setOpen(current => current === plan.id ? null : plan.id)}>
            <span className="fba-history-name">
              <strong>{plan.name}</strong>
              <span className="sub">{names.filter(Boolean).join(' ／ ') || (planState === 'draft' ? 'まだAmazonに送っていません' : planState === 'cancelled' ? '取り消し済み' : 'Amazonの出荷はまだありません')}</span>
            </span>
            <span className="fba-history-cell"><span className="fba-history-label">アカウント</span>{plan.account}</span>
            <span className="fba-history-cell"><span className="fba-history-label">作成</span>{tokyoDateTime(plan.created_at)}</span>
            <span className="fba-history-cell"><span className="fba-history-label">点数</span>{plan.items.length}点{received > 0 && planState !== 'received' ? `（受領${received}）` : ''}</span>
            <span className={`fba-history-state tone-${stateTone[planState]}`}>{fbaPlanStateLabels[planState]}</span>
            <span className="fba-history-chevron" aria-hidden="true">{expanded ? '▲' : '▼'}</span>
          </button>
          {expanded && <div className="fba-history-detail" id={detailId}>
            <div>
              <h4>履歴</h4>
              <ol className="fba-history-timeline">
                {fbaTimeline(plan).map((event, index) => <li key={index} className={`tone-${event.tone}`}><span className="fba-history-time">{event.at ? tokyoDateTime(event.at) : ''}</span><span>{event.label}</span></li>)}
              </ol>
              <dl className="fba-history-meta">
                <div><dt>作成した担当者</dt><dd>{(plan.staff && staffDisplayName({ name: plan.staff.name, code: plan.staff.code ?? undefined, display_name: plan.staff.display_name ?? undefined })) || '—'}</dd></div>
                {plan.shipments.map((shipment, index) => <div key={index}><dt>出荷{plan.shipments.length > 1 ? index + 1 : ''}</dt><dd>{[shipment.confirmation_id, shipment.warehouse, shipment.boxes ? `${shipment.boxes}箱` : ''].filter(Boolean).join(' ／ ') || '—'}</dd></div>)}
              </dl>
              {plan.has_amazon_plan && <a className="btn fba-history-link" href={shipmentsUrl} target="_blank" rel="noopener noreferrer">セラーセントラルの納品を開く</a>}
            </div>
            <div>
              <h4>入っている商品</h4>
              <ul className="fba-history-items">
                {plan.items.map(item => {
                  const got = plan.shipments.reduce((sum, shipment) => sum + (Number(shipment.received?.[item.sku]) || 0), 0);
                  return <li key={item.item_id}>
                    <span className="fba-history-item-name"><strong>{item.serial ?? '—'}</strong> {item.title}</span>
                    <span className="sub fba-history-sku">{item.sku}{item.current_sku && item.current_sku !== item.sku ? `（現在のSKU ${item.current_sku}）` : ''}</span>
                    <span className="fba-history-item-state">
                      {got > 0 && <span className="sub">受領済み</span>}
                      {item.status && <span className="inventory-label inventory-status-label" style={inventoryStatusStyle(item.status)}>{inventoryStatusText(item.status)}</span>}
                    </span>
                  </li>;
                })}
              </ul>
            </div>
          </div>}
        </div>;
      })}
    </div>}
  </section>;
}
