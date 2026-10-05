import { useState, type SyntheticEvent, type KeyboardEvent } from 'react';
import { jpDate, yen } from '@bussan/shared';
import type { DeliveryTask, Staff } from '@bussan/shared';
import TaskDetail from '../pages/TaskDetail';

const STEP_FLAGS = (t: DeliveryTask) => [
  t.inspected && t.cleaned,
  t.product_registered && (t.marketplace === '動作品Amazon返品' || t.photo_uploaded),
  t.packed_on !== null,
  t.shipped_on !== null,
];

const MARKETPLACE_HOSTS: Record<string, string[]> = {
  'メルカリ': ['mercari.com'],
  'ヤフオク': ['auctions.yahoo.co.jp'],
  'ヤフフリ': ['paypayfleamarket.yahoo.co.jp'],
  'PayPayフリマ': ['paypayfleamarket.yahoo.co.jp'],
  'ラクマ': ['fril.jp'],
  'ジモティー': ['jmty.jp'],
};

function isAllowedMarketplaceUrl(marketplace: string, rawUrl: string | null): boolean {
  if (!rawUrl) return false;
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'https:') return false;
    return (MARKETPLACE_HOSTS[marketplace] || []).some(host => url.hostname === host || url.hostname.endsWith(`.${host}`));
  } catch {
    return false;
  }
}

function CopyableText({ label, value, displayValue }: { label: string; value: string; displayValue?: string }) {
  const [state, setState] = useState<'ready' | 'copied' | 'failed'>('ready');

  async function copy(event: SyntheticEvent<HTMLElement>) {
    event.stopPropagation();
    let copied = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
        copied = true;
      }
    } catch {
      // Fall back to the legacy clipboard path when browser permission is unavailable.
    }
    if (!copied) {
      const field = document.createElement('textarea');
      field.value = value;
      field.setAttribute('readonly', '');
      field.style.position = 'fixed';
      field.style.opacity = '0';
      document.body.appendChild(field);
      field.select();
      copied = document.execCommand('copy');
      field.remove();
    }
    setState(copied ? 'copied' : 'failed');
    window.setTimeout(() => setState('ready'), 1600);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); void copy(event); }
  }

  return <span className="copyable-text" role="button" tabIndex={0} aria-label={`${label}をコピー`} aria-live="polite" title={`${label}をクリックしてコピー`} onClick={copy} onKeyDown={handleKeyDown}>
    {state === 'copied' ? `${label}✓` : state === 'failed' ? `${label}（コピー失敗）` : `${label} ${(displayValue ?? value) || '—'}`}
  </span>;
}

export default function TaskCard({ task, amazonImageUrl, members, staff, expandedId, onOpenMember, onOpen, onClose, onTaskChange, selected, onSelect, disabled }: { task: DeliveryTask; amazonImageUrl: string | null; members: DeliveryTask[]; staff: Staff; expandedId: string | null; onOpenMember: (id: string) => void; onOpen: () => void; onClose: () => void; onTaskChange: (task: DeliveryTask) => void; selected: boolean; onSelect: () => void; disabled: boolean }) {
  const flags = STEP_FLAGS(task);
  const done = flags.filter(Boolean).length;

  return (
    <div className="card task-card" data-expanded={!!expandedId}>
      <input type="checkbox" aria-label={`${task.sku}を出力対象に選択`} checked={selected} disabled={disabled} onChange={onSelect} />
      <div className="task-content">
      <div className="task-card-overview">
        <div className="task-card-info">
          <span className="muted">購入日 {jpDate(task.purchased_at)}</span>
          <span className="muted">販売先 {task.sales_channel || '—'}</span>
          <CopyableText label="販売金額" value={task.sold_price == null ? '' : String(task.sold_price)} displayValue={yen(task.sold_price)} />
          <CopyableText label="SKU" value={task.sku} />
          <span className="title">{task.is_accessory && <span className="badge" style={{ marginRight: 6 }}>付属品</span>}<CopyableText label={task.marketplace === '動作品Amazon返品' ? 'FNSKU' : '型番'} value={task.model_no || task.title} /></span>
          <CopyableText label="ASIN" value={task.asin || '—'} />
          <span className="task-item-id-line"><CopyableText label={task.marketplace === '動作品Amazon返品' ? 'EAN' : '商品ID'} value={task.marketplace_item_id || '—'} /><button type="button" className="task-item-page-link" disabled={!isAllowedMarketplaceUrl(task.marketplace, task.marketplace_url)} title={isAllowedMarketplaceUrl(task.marketplace, task.marketplace_url) ? '商品ページを開く' : '登録されたURLは対応フリマサイトの商品ページではありません'} onClick={() => { if (isAllowedMarketplaceUrl(task.marketplace, task.marketplace_url)) window.open(task.marketplace_url!, '_blank', 'noopener,noreferrer'); }}>商品ページ</button></span>
          <CopyableText label="追跡番号" value={task.tracking_no || '—'} />
        </div>
        <div className="task-photo-action">
          <button type="button" className="task-card-photo-button" aria-label={expandedId ? '作業詳細を閉じる' : '写真をクリックして作業詳細を開く'} aria-expanded={!!expandedId} onClick={() => expandedId ? onClose() : onOpen()}>
            {amazonImageUrl ? <img className="task-card-photo" src={amazonImageUrl} alt={`${task.title}のAmazon商品画像`} loading="lazy" /> : <span className="task-card-photo task-card-no-photo" aria-label="Amazon商品画像なし">写真なし</span>}
          </button>
          <div className="progress" aria-label={`作業 ${done}/${flags.length}`}>
            {flags.map((f, i) => <span key={i} data-done={f} />)}
          </div>
        </div>
      </div>
      {members.length > 1 && <div className="task-members">
        {members.filter(member => member.id !== task.id).map(member => <div key={member.id} className="task-member-row">
          <button type="button" className="btn task-member-open" aria-expanded={expandedId === member.id} onClick={() => onOpenMember(member.id)}>
            {member.is_accessory ? '付属品' : '同じ商品'}：{member.title}
          </button>
          <CopyableText label="追跡番号" value={member.tracking_no || '—'} />
          <span className="muted task-member-date">{jpDate(member.purchased_at)}</span>
        </div>)}
      </div>}
      </div>
      {expandedId && <TaskDetail key={expandedId} itemId={expandedId} staff={staff} onClose={onClose} onChanged={onTaskChange} />}
    </div>
  );
}
