import { useEffect, useRef, useState } from 'react';
import { completeSpareShipping, fetchSpareShippingTasks, sendSpareShipping, staffDisplayName, canViewDeliveryAssignee } from '@bussan/shared';
import type { SpareShippingTask, Staff } from '@bussan/shared';

const messageOf = (cause: unknown) => cause instanceof Error ? cause.message
  : (cause as {message?:string})?.message || '発送タスクを処理できませんでした。';

function ShippingRow({task,staff,management,onChanged}:{
  task:SpareShippingTask;staff:Staff;management:boolean;onChanged:()=>void;
}) {
  const [editing,setEditing]=useState(false);
  const [tracking,setTracking]=useState('');
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const owner=staffDisplayName({code:task.owner_code,name:task.owner_name});
  const recipient=staffDisplayName({code:task.recipient_code,name:task.recipient_name});
  const canShip=!task.sent_at && (task.owner_staff_id===staff.id || canViewDeliveryAssignee(staff));
  const overview=management || canViewDeliveryAssignee(staff);
  const canComplete=management && staff.role==='admin' && !!task.sent_at;
  async function act(send:boolean) {
    if(busy) return;
    setBusy(true);setError('');
    try {
      if(send) await sendSpareShipping(task.id,tracking.trim());
      else await completeSpareShipping(task.id);
      setEditing(false);onChanged();
    } catch(cause) {setError(messageOf(cause));}
    finally {setBusy(false);}
  }
  return <li className="spare-shipping-row" id={`spare-shipping-${task.id}`}>
    <div className="spare-shipping-heading">
      <span>{overview
        ? `${owner}→${recipient}の${task.sent_at ? '発送済み' : '発送準備中'}`
        : `${recipient}へ発送お願いします。`}</span>
      {canComplete && <button className="btn" disabled={busy} onClick={()=>void act(false)}>完了</button>}
      {canShip && !editing && <button className="btn" onClick={()=>setEditing(true)}>発送</button>}
    </div>
    <div className="spare-shipping-details">
      <span>品名：{task.title}</span>
      {overview && task.sent_at ? <>
        <span>通番号：{task.lot_seq}</span><span>追跡番号：{task.tracking_no}</span>
      </> : <>
        <span>メーカー：{task.manufacturer || '未登録'}</span>
        <span>仕入先：{task.marketplace || '未登録'}</span>
        <span>商品ID：{task.marketplace_item_id || '未登録'}</span>
        <span>利用記録：{task.usage_note || '—'}</span>
      </>}
    </div>
    {editing && canShip && <form className="spare-shipping-form" onSubmit={event=>{event.preventDefault();void act(true);}}>
      <label className="field"><span>追跡番号</span><input value={tracking} autoFocus required maxLength={200}
        disabled={busy} onChange={event=>setTracking(event.target.value)} /></label>
      <button className="btn primary" disabled={busy || !tracking.trim()}>送信</button>
      <button type="button" className="btn" disabled={busy} onClick={()=>setEditing(false)}>キャンセル</button>
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
    const visible=()=>{if(document.visibilityState==='visible')void refresh();};
    void refresh();
    const timer=window.setInterval(visible,30000);
    window.addEventListener('focus',visible);document.addEventListener('visibilitychange',visible);
    return()=>{active=false;window.clearInterval(timer);window.removeEventListener('focus',visible);
      document.removeEventListener('visibilitychange',visible);};
  },[revision,staff.id]);
  const visible=rows.filter(task=>canViewDeliveryAssignee(staff) || (management ? staff.role==='admin' || (task.owner_staff_id===staff.id && !task.sent_at)
    : task.owner_staff_id===staff.id && !task.sent_at));
  if(error) return <li className="spare-shipping-row"><p className="error" role="alert">{error}</p>
    <button className="btn" onClick={()=>void refreshRef.current()}>再読み込み</button></li>;
  return <>{visible.map(task=><ShippingRow key={task.id} task={task} staff={staff} management={management}
    onChanged={()=>{setRows(current=>current.filter(row=>row.id!==task.id));setRevision(n=>n+1);onChanged?.();}} />)}</>;
}
