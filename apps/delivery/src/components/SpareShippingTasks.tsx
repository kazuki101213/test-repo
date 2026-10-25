import { useEffect, useRef, useState } from 'react';
import { fetchSpareShippingTasks, sendSpareShipping, staffDisplayName, canViewDeliveryAssignee, resolveSpareUsageItem } from '@bussan/shared';
import type { SpareShippingTask, Staff } from '@bussan/shared';

const messageOf = (cause: unknown) => cause instanceof Error ? cause.message
  : (cause as {message?:string})?.message || '発送依頼を処理できませんでした。';

function supplierItemUrl(task: SpareShippingTask): string | undefined {
  const id = task.marketplace_item_id?.trim();
  if (!id) return;
  if (task.marketplace === 'ヤフオク' && /^[a-z]\d+$/i.test(id)) return `https://auctions.yahoo.co.jp/jp/auction/${id}`;
  if (task.marketplace === 'メルカリ' && /^m\d+$/.test(id)) return `https://jp.mercari.com/item/${id}`;
  if (['ヤフフリ', 'PayPayフリマ'].includes(task.marketplace || '') && /^[a-z]\d+$/i.test(id)) return `https://paypayfleamarket.yahoo.co.jp/item/${id}`;
  if (task.marketplace === 'ラクマ' && /^[a-f\d]{32}$/i.test(id)) return `https://item.fril.jp/${id}`;
}

function ShippingRow({task,staff,management,onChanged}:{
  task:SpareShippingTask;staff:Staff;management:boolean;onChanged:()=>void;
}) {
  const [editing,setEditing]=useState(false);
  const [tracking,setTracking]=useState('');
  const [serialMarked,setSerialMarked]=useState(false);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const usageOpening=useRef(false);
  const [usageBusy,setUsageBusy]=useState(false);
  async function openUsage(serial:string){
    if(usageOpening.current)return;usageOpening.current=true;setUsageBusy(true);setError('');
    try{const id=await resolveSpareUsageItem(serial);window.location.assign('?itemId='+encodeURIComponent(id));}
    catch(cause){setError(messageOf(cause));}
    finally{usageOpening.current=false;setUsageBusy(false);}
  }
  const usageLinks=(task.usage_note||'—').split(/([0-9]+[a-z]*)/i).map((part,index)=>/^[1-9][0-9]*[a-z]*$/i.test(part)
    ?<button type="button" role="link" className="spare-shipping-text-link" key={index} disabled={usageBusy} onClick={()=>void openUsage(part)}>{part}</button>:part);
  const owner=staffDisplayName({code:task.owner_code,name:task.owner_name});
  const recipient=staffDisplayName({code:task.recipient_code,name:task.recipient_name});
  const canShip=!task.sent_at && (task.owner_staff_id===staff.id || canViewDeliveryAssignee(staff));
  const overview=management || canViewDeliveryAssignee(staff);
  const supplierUrl=supplierItemUrl(task);
  async function act() {
    if(busy || !canShip || !tracking.trim() || !serialMarked) return;
    setBusy(true);setError('');
    try {
      await sendSpareShipping(task.id,tracking.trim());
      setEditing(false);onChanged();
    } catch(cause) {setError(messageOf(cause));}
    finally {setBusy(false);}
  }
  return <li className="spare-shipping-row delivery-return-task delivery-spare-shipping-task" id={`spare-shipping-${task.id}`}>
    <div className="spare-shipping-heading">
      <span>{overview
        ? `${owner}→${recipient}の${task.sent_at ? '発送済み' : '発送準備中'}`
        : `${recipient}へ発送お願いします。`}</span>
    </div>
    {canShip && !editing && <button type="button" className="btn spare-shipping-open" onClick={()=>{setSerialMarked(false);setEditing(true);}}>発送</button>}
    <div className="spare-shipping-details">
      <div className="spare-shipping-detail-line"><span>通番号：<a href={'?itemId='+encodeURIComponent(task.item_id)}>{task.lot_seq}</a></span>{!task.sent_at&&<span>利用記録：{usageLinks}</span>}</div>
      {overview && task.sent_at ? <>
        <span>追跡番号：{task.tracking_no}</span>
      </> : <>
        <div className="spare-shipping-detail-line"><span>{task.manufacturer || 'メーカー未登録'}</span><span>{supplierUrl?<a href={supplierUrl} target="_blank" rel="noopener noreferrer" aria-label="仕入先の商品ページを開く">{task.marketplace_item_id}</a>:task.marketplace_item_id||'商品ID未登録'}</span></div>
      </>}
    </div>
    {editing && canShip && <form className="spare-shipping-form" onSubmit={event=>{event.preventDefault();void act();}}>
      <div className="spare-shipping-reference">通番号/利用記録：{task.lot_seq} / {task.usage_note || '—'}</div>
      <label className="spare-shipping-confirmation"><input type="checkbox" required checked={serialMarked}
        disabled={busy} onChange={event=>setSerialMarked(event.target.checked)} />
        <span>「通番号/利用記録」を記載し、通番号に◯をつけましたか？</span></label>
      <div className="spare-shipping-actions">
        <label className="field"><span>追跡番号</span><input value={tracking} autoFocus required maxLength={200}
          disabled={busy} onChange={event=>setTracking(event.target.value)} /></label>
        <button className="btn primary" disabled={busy || !tracking.trim() || !serialMarked}>送信</button>
        <button type="button" className="btn" disabled={busy} onClick={()=>setEditing(false)}>キャンセル</button>
      </div>
    </form>}
    {error && <p className="error" role="alert">{error}</p>}
  </li>;
}
export default function SpareShippingTasks({staff,management=false,onChanged}:{
  staff:Staff;management?:boolean;onChanged?:()=>void;
}) {
  const [rows,setRows]=useState<SpareShippingTask[]>([]);
  const [error,setError]=useState('');
  const [revision,setRevision]=useState(0);
  // A refresh started before sending must not bring a successfully sent task back.
  const dismissed=useRef(new Set<string>());
  const refreshRef=useRef<()=>Promise<void>>(async()=>{});
  useEffect(()=>{
    let active=true;let fetching=false;
    const refresh=async()=>{
      if(fetching) return;
      fetching=true;
      try {const data=await fetchSpareShippingTasks();if(active){setRows(data);setError('');}}
      catch(cause){if(active)setError(messageOf(cause));}
      finally{fetching=false;}
    };
    refreshRef.current=refresh;
    let lastAutomaticCheck=0;
    const visible=()=>{if(document.visibilityState==='visible'&&Date.now()-lastAutomaticCheck>=30000){lastAutomaticCheck=Date.now();void refresh();}};
    void refresh();
    const timer=window.setInterval(visible,24*60*60*1000);
    window.addEventListener('focus',visible);document.addEventListener('visibilitychange',visible);
    return()=>{active=false;window.clearInterval(timer);window.removeEventListener('focus',visible);
      document.removeEventListener('visibilitychange',visible);};
  },[revision,staff.id]);
  const visible=rows.filter(task=>!task.sent_at && !dismissed.current.has(task.id) && !task.completed_at && (management
    ? staff.role==='admin' || (task.owner_staff_id===staff.id && !task.sent_at)
    : !task.sent_at && (canViewDeliveryAssignee(staff) || task.owner_staff_id===staff.id)));
  if(error) return <li className="spare-shipping-row"><p className="error" role="alert">{error}</p>
    <button className="btn" onClick={()=>void refreshRef.current()}>再読み込み</button></li>;
  return <>{visible.map(task=><ShippingRow key={`${task.id}:${task.recipient_staff_id}`} task={task} staff={staff} management={management}
    onChanged={()=>{dismissed.current.add(task.id);setRows(current=>current.filter(row=>row.id!==task.id));setRevision(n=>n+1);onChanged?.();}} />)}</>;
}
