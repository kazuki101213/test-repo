import { salesChannelLabel } from '@bussan/shared';
import { lazy, Suspense, useState, type SyntheticEvent, type KeyboardEvent } from 'react';
import { jpDate, canViewDeliveryAssignee, productModelText, inventorySerial, isSeparateAccessory, inventoryBoxColor, inventoryStaffStyle, inventorySiteStyle, inventoryStatusStyle, inventoryStatusText, staffDisplayName, accessoryDisplayLabel, noticeProductUrl } from '@bussan/shared';
import type { DeliveryInventoryRow, DeliveryTask, Staff, ProductPanel } from '@bussan/shared';
import TaskDetail from '../pages/TaskDetail';
import WorkflowControls from './WorkflowControls';
import {fetchTask} from '../api';
import {canSelectFbaItem} from '../fbaSelection';
import './approvedInventory.css';
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

export default function TaskCard({ readOnly = false, showAssignee = false, task, amazonImageUrl, members, originalMarketplaceIds, staff, unreadItemIds, onDetailOpened, detailRevision, expandedId, onOpenMember, onOpen, onClose, onTaskChange,selection }: { readOnly?: boolean; showAssignee?: boolean; task: DeliveryInventoryRow; amazonImageUrl: string | null; members: DeliveryInventoryRow[]; originalMarketplaceIds: Map<string, string>; staff: Staff; unreadItemIds: Set<string>; onDetailOpened: (itemId: string) => void; detailRevision: number; expandedId: string | null; onOpenMember: (id: string) => void; onOpen: () => void; onClose: () => void; onTaskChange: (task: DeliveryTask) => void;selection?:{ids:string[];onChange:(ids:string[])=>void} }) {
 const [panel,setPanel]=useState<ProductPanel>(()=>new URLSearchParams(window.location.search).get('openMessages')==='1'?'messages':'photos');
 const [actionError,setActionError]=useState<string|null>(null);
 const productIdFor=(item:DeliveryTask)=>(item.is_accessory||item.marketplace==='動作品Amazon返品'?item.marketplace_item_id:originalMarketplaceIds.get(item.id)||item.marketplace_item_id)||'—';
 const modelFor=productModelText;
 const itemIdLabel=(item:DeliveryTask)=>item.marketplace==='動作品Amazon返品'?'ENA':'商品ID';
 const trackingLabel=(item:DeliveryTask)=>item.marketplace==='動作品Amazon返品'?'FNSKU':'追跡番号';
 const bundled=members.filter(item=>item.id!==task.id&&item.is_accessory&&!isSeparateAccessory(item));
 const separate=members.filter(item=>item.id!==task.id&&(isSeparateAccessory(item)||!item.is_accessory));
 const selected=members.find(item=>item.id===expandedId)??task;
 const listingSkus=isSeparateAccessory(selected)?[selected.sku]:Array.from(new Set([task.sku,...bundled.map(item=>item.sku)]));
 const operate=(item:DeliveryTask)=>!readOnly&&(staff.role==='admin'||item.deliverer_id===staff.id);
 function openPanel(item:DeliveryTask,mode:ProductPanel){setPanel(mode);if(expandedId!==item.id){if(item.id===task.id)onOpen();else onOpenMember(item.id);}}
 async function refreshAction(item:DeliveryTask){const updated=await fetchTask(item.id,canViewDeliveryAssignee(staff));if(updated)onTaskChange(updated);}
 const status=(item:DeliveryTask)=><span className="inventory-label inventory-status-label" style={inventoryStatusStyle(item.status)}>{inventoryStatusText(item.status)}</span>;
 const badge=(text:string)=><span className="inventory-label inventory-accessory-label">{text}</span>;
 const independent=(item:DeliveryTask)=>!item.is_accessory||isSeparateAccessory(item);
 const selectItem=(item:DeliveryTask)=>selection&&independent(item)?<label className="delivery-fba-select" title="FBA・商品登録前の商品を選択"><input type="checkbox" className="delivery-fba-checkbox" aria-label={`${inventorySerial(item)}をFBA納品に選択`} checked={selection.ids.includes(item.id)} disabled={!canSelectFbaItem(item,staff,readOnly)} onChange={event=>selection.onChange(event.target.checked?Array.from(new Set([...selection.ids,item.id])):selection.ids.filter(id=>id!==item.id))}/></label>:null;
 const people=(item:DeliveryTask)=><div className="delivery-people">{[
  ['仕入担当者',staffDisplayName(item.purchaser_name)||'—',true],
  ['納品担当者',staffDisplayName(item.deliverer_name||(item.deliverer_id===staff.id?staffDisplayName(staff):''))||'未設定',true],['仕入先',item.marketplace,false],['販売先',salesChannelLabel(item.sales_channel)||'—',false],
 ].map(([label,value,person])=><div key={String(label)}><small>{label}</small><span className="inventory-label" style={person?inventoryStaffStyle(String(value)):inventorySiteStyle(String(value))}>{value}</span></div>)}</div>;
 const sourceLink=(item:DeliveryTask)=>{const url=noticeProductUrl(item.marketplace,productIdFor(item),item.marketplace_url);return <button type="button" className="task-item-page-link inventory-inline-link" aria-label="仕入先の商品ページを開く" disabled={!isAllowedMarketplaceUrl(item.marketplace,url)} title={isAllowedMarketplaceUrl(item.marketplace,url)?'仕入先の商品ページを開く':'登録されたURLは対応フリマサイトの商品ページではありません'} onClick={()=>{if(isAllowedMarketplaceUrl(item.marketplace,url))window.open(url!,'_blank','noopener,noreferrer');}}>↗</button>;};
 const field=(label:string,value:string,className='')=><span className={`task-detail-field${className?' '+className:''}`}><span>{label}</span><span>{value}</span></span>;
 const source=(item:DeliveryTask)=><span className="task-item-id-line"><CopyableText label={itemIdLabel(item)} value={productIdFor(item)}/>{sourceLink(item)}</span>;
 const comments=(item:DeliveryTask)=>field('仕入担当者からのコメント',item.memo?.trim()?item.memo:'—','purchaser-comment');
 const controls=(item:DeliveryTask)=>operate(item)?<div className="delivery-record-actions" data-record-id={item.id}><WorkflowControls task={item} onChanged={()=>refreshAction(item)} onError={message=>setActionError(message?`${item.sku}：${message}`:null)} onPanel={mode=>openPanel(item,mode)}/></div>:<span className="muted task-read-only">閲覧のみ</span>;
 const accessoryInfo=(item:DeliveryInventoryRow,compact=false)=> <>
  <div className={`delivery-accessory-identity${independent(item)?' independent':''}`}>
   {independent(item)&&<span className="delivery-accessory-state">{status(item)}<b className="delivery-mobile-accessory-name">{item.title}</b></span>}
   <div className="delivery-accessory-text"><div className="delivery-accessory-title">{selectItem(item)}<strong>{independent(item)?inventorySerial(item):task.inventory_group_serial||inventorySerial(task)}</strong>{independent(item)&&<b>{item.title}</b>}{badge(item.is_accessory?accessoryDisplayLabel(item):'本体')}{!independent(item)&&<b>{item.title}</b>}</div>{independent(item)&&<CopyableText label="SKU" value={item.sku}/>}</div>
  </div>
  {people(item)}
  <div className={`delivery-accessory-details${compact?' compact':''}`}>
   {source(item)}<CopyableText label={trackingLabel(item)} value={item.tracking_no||'—'}/>
   {field('仕入日',jpDate(item.purchased_at))}
   {item.is_accessory&&field('利用記録',item.accessory_usage_note||'未記録','delivery-accessory-usage')}
   {item.memo?.trim()&&item.memo.trim()!==item.accessory_usage_note&&comments(item)}
  </div>
 </>;
 const mainAccessory=task.is_accessory;
 return <div id={`delivery-task-${task.id}`} className="card task-card approved-delivery-card" data-expanded={!!expandedId} data-item-status={task.status} style={{backgroundColor:inventoryBoxColor(task.status,task.purchased_at)}}>
  {members.some(member=>unreadItemIds.has(member.id))&&<span className="photo-approval-mark" role="img" aria-label="未確認のメッセージまたは写真承認があります"/>}
  {mainAccessory?<section className="delivery-independent-record" data-item-id={task.id} data-item-status={task.status} style={{backgroundColor:inventoryBoxColor(task.status,task.purchased_at)}}>{accessoryInfo(task)}{controls(task)}</section>:<div className="approved-delivery-body">
   <div className="delivery-main-info">
    <div className="delivery-main-identity"><button type="button" className="task-card-photo-button" disabled={!operate(task)} aria-label={expandedId===task.id&&panel==='photos'?'写真を閉じる':'写真を表示'} aria-expanded={expandedId===task.id} onClick={()=>expandedId===task.id&&panel==='photos'?onClose():openPanel(task,'photos')}>{amazonImageUrl?<img className="task-card-photo" src={amazonImageUrl} alt={`${task.title}の商品画像`} loading="lazy"/>:<span className="task-card-photo task-card-no-photo">写真なし</span>}</button>
     <div className="delivery-identity-text"><div className="delivery-serial-line">{selectItem(task)}{status(task)}<strong>{inventorySerial(task)}</strong>{badge(bundled.length?'付属品'+bundled.length+'点':'付属品同梱')}</div><div className="delivery-model-line"><b>{modelFor(task)}</b><span>{task.asin||'—'}{task.asin&&<a className="inventory-inline-link" href={`https://www.amazon.co.jp/dp/${encodeURIComponent(task.asin)}`} target="_blank" rel="noopener noreferrer" aria-label={`${task.asin}をAmazonで開く`}>↗</a>}</span></div><div className="delivery-main-sku"><CopyableText label="SKU" value={task.sku}/></div><div className="delivery-tracking-id"><CopyableText label={trackingLabel(task)} value={task.tracking_no||'—'}/>{source(task)}</div></div>
    </div>
    {people(task)}
    <div className="delivery-main-dates">{field('コンディション',task.condition||'—')}{field('仕入日',jpDate(task.purchased_at))}{field('作業完了日',task.packed_on?jpDate(task.packed_on):'未登録')}{comments(task)}</div>
   </div>
   <div className="delivery-bundled">{bundled.map(item=><section key={item.id} className="delivery-bundled-record" data-item-id={item.id} style={{backgroundColor:inventoryBoxColor(task.status,task.purchased_at)}}>{accessoryInfo(item,true)}</section>)}</div>
   {controls(task)}
  </div>}
  {separate.map(item=><section key={item.id} className="delivery-independent-record" data-kind="separate" data-item-id={item.id} data-item-status={item.status} style={{backgroundColor:inventoryBoxColor(item.status,item.purchased_at)}}>{accessoryInfo(item)}{controls(item)}</section>)}
  {actionError&&<p className="error" role="alert">{actionError}</p>}
  {operate(selected)&&expandedId&&(panel==='listing'||panel==='shipping'||panel==='messages'&&(selected.status==='取引中'||selected.status==='出品中')?<Suspense fallback={<p>読み込み中…</p>}><SellerPanel listingSkus={listingSkus} mode={panel} task={selected} staff={staff} onClose={onClose} onChanged={onTaskChange}/></Suspense>:<TaskDetail mode={panel} key={`${expandedId}-${detailRevision}-${panel}`} itemId={expandedId} latestTask={selected} staff={staff} listingSkus={listingSkus} onClose={onClose} onChanged={onTaskChange} onOpened={onDetailOpened}/>)}
 </div>;
}
