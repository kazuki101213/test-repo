import { lazy, Suspense, useState, type SyntheticEvent, type KeyboardEvent } from 'react';
import { jpDate, canViewDeliveryAssignee, productModelText } from '@bussan/shared';
import type { DeliveryTask, Staff, ProductPanel } from '@bussan/shared';
import TaskDetail from '../pages/TaskDetail';
import WorkflowControls from './WorkflowControls';
import {fetchTask} from '../api';
const SellerPanel=lazy(()=>import('./SellerPanel')); 

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
    {state === 'ready' ? <><span>{label}</span>{' '}<span>{(displayValue ?? value) || '—'}</span></> : state === 'copied' ? `${label}✓` : `${label}（コピー失敗）`}
  </span>;
}

export default function TaskCard({ readOnly = false, showAssignee = false, task, amazonImageUrl, members, originalMarketplaceIds, staff, unreadItemIds, onDetailOpened, detailRevision, expandedId, onOpenMember, onOpen, onClose, onTaskChange, selected, onSelect, disabled }: { readOnly?: boolean; showAssignee?: boolean; task: DeliveryTask; amazonImageUrl: string | null; members: DeliveryTask[]; originalMarketplaceIds: Map<string, string>; staff: Staff; unreadItemIds: Set<string>; onDetailOpened: (itemId: string) => void; detailRevision: number; expandedId: string | null; onOpenMember: (id: string) => void; onOpen: () => void; onClose: () => void; onTaskChange: (task: DeliveryTask) => void; selected: boolean; onSelect: () => void; disabled: boolean }) {
  const [panel,setPanel]=useState<ProductPanel>(()=>new URLSearchParams(window.location.search).get('openMessages')==='1'?'messages':'photos');
  const [actionError,setActionError]=useState<string|null>(null);
  async function refreshAction(){const updated=await fetchTask(task.id,canViewDeliveryAssignee(staff));if(updated)onTaskChange(updated);}
  function openPanel(mode:ProductPanel){setPanel(mode);if(mode==='comments'&&expandedId===task.id&&panel!=='comments')return;onOpen();}
  const productIdFor = (item: DeliveryTask) => (item.marketplace === '動作品Amazon返品' ? item.marketplace_item_id : originalMarketplaceIds.get(item.id) || item.marketplace_item_id) || '—';
  const modelFor = productModelText;
  const itemIdLabel = (item: DeliveryTask) => item.marketplace === '動作品Amazon返品' ? 'ENA' : '商品ID';
  const trackingLabel = (item: DeliveryTask) => item.marketplace === '動作品Amazon返品' ? 'FNSKU' : '追跡番号';
  const listingSkus = Array.from(new Set([
    (members.find(member => !member.is_accessory) ?? task).sku,
    ...members.filter(member => member.is_accessory).map(member => member.sku),
  ].filter(Boolean)));

  return (
    <div id={`delivery-task-${task.id}`} className="card task-card" data-expanded={!!expandedId} data-item-status={task.status}>
      {members.some(member => unreadItemIds.has(member.id)) && <span className="photo-approval-mark" role="img" aria-label="未確認のメッセージまたは写真承認があります" />}
      <input type="checkbox" aria-label={`${task.sku}を出力対象に選択`} checked={selected} disabled={disabled || readOnly} onChange={onSelect} />
      <div className="task-content">
      <div className="task-product-summary">
      <div className="task-card-overview">
        <div className="task-card-info">
          {readOnly && <span className="muted task-read-only">閲覧のみ</span>}
          <span className="task-section-title">{task.is_accessory ? '付属品' : '本体'}</span>
          {task.is_accessory && <span className="task-detail-field"><span>品名</span><span>{task.title}</span></span>}
          {task.is_accessory&&<span className="task-detail-field"><span>利用記録</span><span>{task.inventory_group_serial||task.lot_seq}</span></span>}
          <CopyableText label="SKU" value={task.sku} />
          <span className="task-item-id-line"><CopyableText label={itemIdLabel(task)} value={productIdFor(task)} /><button type="button" className="task-item-page-link" aria-label="仕入先の商品ページを開く" disabled={!isAllowedMarketplaceUrl(task.marketplace, task.marketplace_url)} title={isAllowedMarketplaceUrl(task.marketplace, task.marketplace_url) ? '仕入先の商品ページを開く' : '登録されたURLは対応フリマサイトの商品ページではありません'} onClick={() => { if (isAllowedMarketplaceUrl(task.marketplace, task.marketplace_url)) window.open(task.marketplace_url!, '_blank', 'noopener,noreferrer'); }}><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M14 3h7v7M21 3l-11 11M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5" /></svg></button></span>
          <CopyableText label={trackingLabel(task)} value={task.tracking_no || '—'} />
          <CopyableText label="型番" value={modelFor(task)} />
          <CopyableText label="ASIN" value={task.asin || '—'} />
          <span className="task-detail-field"><span>コンディション</span><span>{task.condition || '—'}</span></span>
          <span className="task-detail-field"><span>販売先</span><span>{task.sales_channel || '—'}</span></span>
          <span className="task-detail-field"><span>仕入日</span><span>{jpDate(task.purchased_at)}</span></span>
          <span className="task-detail-field"><span>作業完了日</span><span>{task.packed_on ? jpDate(task.packed_on) : '未登録'}</span></span>
          <span className="task-detail-field"><span>仕入先</span><span>{task.marketplace}</span></span>
          <span className="task-detail-field"><span>状態</span><span>{task.status}</span></span>
          {(canViewDeliveryAssignee(staff) || showAssignee) && <span className="task-detail-field task-assignee"><span>納品担当者</span><span>{task.deliverer_name || '未設定'}</span></span>}
          {task.memo?.trim() && <span className="purchaser-comment">仕入担当者からのコメント：{task.memo}</span>}

        </div>
        <div className="task-photo-action">
          <button type="button" className="task-card-photo-button" disabled={readOnly} aria-label={expandedId&&panel==='photos' ? '写真を閉じる' : '写真を表示'} aria-expanded={!!expandedId} onClick={() => expandedId&&panel==='photos' ? onClose() : openPanel('photos')}>
            {amazonImageUrl ? <img className="task-card-photo" src={amazonImageUrl} alt={`${task.title}のAmazon商品画像`} loading="lazy" /> : <span className="task-card-photo task-card-no-photo" aria-label="Amazon商品画像なし">写真なし</span>}
          </button>
        </div>
      </div>
      {members.length > 1 && <div className="task-members">
        {members.filter(member => member.id !== task.id).map(member => <div key={member.id} className={`task-member-row${member.is_accessory ? ' task-member-accessory' : ''}`}>
          {member.is_accessory ? <>
            <span className="task-section-title">付属品</span>
            <button type="button" className="task-member-open task-detail-field" disabled={readOnly} aria-expanded={expandedId === member.id} onClick={() => {setPanel('photos');onOpenMember(member.id);}}><span>品名</span><span>{member.title}</span></button>
            <span className="task-item-id-line"><CopyableText label={itemIdLabel(member)} value={productIdFor(member)} /><button type="button" className="task-item-page-link" aria-label="仕入先の商品ページを開く" disabled={!isAllowedMarketplaceUrl(member.marketplace, member.marketplace_url)} title={isAllowedMarketplaceUrl(member.marketplace, member.marketplace_url) ? '仕入先の商品ページを開く' : '登録されたURLは対応フリマサイトの商品ページではありません'} onClick={() => { if (isAllowedMarketplaceUrl(member.marketplace, member.marketplace_url)) window.open(member.marketplace_url!, '_blank', 'noopener,noreferrer'); }}><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M14 3h7v7M21 3l-11 11M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5" /></svg></button></span>
            <CopyableText label={trackingLabel(member)} value={member.tracking_no || '—'} />
            <span className="task-detail-field"><span>仕入日</span><span>{jpDate(member.purchased_at)}</span></span>
            <span className="task-detail-field"><span>仕入先</span><span>{member.marketplace}</span></span>
            <span className="task-detail-field"><span>利用記録</span><span>{task.inventory_group_serial||task.sku.split(/[-_]/)[0]||member.lot_seq}</span></span>
            {(canViewDeliveryAssignee(staff) || showAssignee) && <span className="task-detail-field task-assignee"><span>納品担当者</span><span>{member.deliverer_name || '未設定'}</span></span>}
            {member.memo?.trim() && <span className="purchaser-comment">仕入担当者からのコメント：{member.memo}</span>}
          </> : <>
            <button type="button" className="btn task-member-open" disabled={readOnly} aria-expanded={expandedId === member.id} onClick={() => onOpenMember(member.id)}>
              同じ商品：{modelFor(member)}
            </button>
            {member.marketplace === '動作品Amazon返品' && <CopyableText label="ENA" value={productIdFor(member)} />}
            <CopyableText label={trackingLabel(member)} value={member.tracking_no || '—'} />
            {(canViewDeliveryAssignee(staff) || showAssignee) && <span>納品担当者 {member.deliverer_name || '未設定'}</span>}
            {member.memo?.trim() && <span className="purchaser-comment">仕入担当者からのコメント：{member.memo}</span>}
            <span className="muted task-member-date">仕入日 {jpDate(member.purchased_at)}</span>
          </>}
        </div>)}
      </div>}
      </div>
      {!readOnly && <WorkflowControls task={task} onChanged={refreshAction} onError={setActionError} onPanel={openPanel} />}
      {actionError&&<p className="error" role="alert">{actionError}</p>}
      </div>
      {!readOnly && expandedId && (panel==='listing'||panel==='shipping'||panel==='messages'&&(task.status==='取引中'||task.status==='出品中') ? <Suspense fallback={<p>読み込み中…</p>}><SellerPanel listingSkus={listingSkus} mode={panel} task={members.find(member=>member.id===expandedId)??task} staff={staff} onClose={onClose} onChanged={onTaskChange}/></Suspense> : <TaskDetail mode={panel} key={`${expandedId}-${detailRevision}-${panel}`} itemId={expandedId} latestTask={members.find(member => member.id === expandedId)} staff={staff} listingSkus={listingSkus} onClose={onClose} onChanged={onTaskChange} onOpened={onDetailOpened} />)}
    </div>
  );
}
