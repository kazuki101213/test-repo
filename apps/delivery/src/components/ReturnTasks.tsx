import {useEffect,useRef,useState} from 'react';
import {readResourceSnapshot,noticeProductUrl} from '@bussan/shared';
import {completeDeliveryNotice} from '../api';
type ReturnTask={id:string;item_id:string;kind:'photo_return'|'photo_approved'|'reply'|'shipping';reason?:string|null;expires_at?:string|null;sku:string;lot_seq:number;marketplace_item_id:string|null;marketplace:string|null;marketplace_url:string|null};
const expiry=(row:ReturnTask)=>row.kind==='photo_approved'||row.kind==='shipping'?Date.parse(row.expires_at||''):NaN;
const unexpired=(row:ReturnTask)=>!(expiry(row)<=Date.now());
export default function ReturnTasks({staffId}:{staffId:string}){
 const [rows,setRows]=useState<ReturnTask[]>([]),[error,setError]=useState(''),[pending,setPending]=useState<string[]>([]);
 const locks=useRef(new Set<string>());
 const completed=useRef(new Set<string>());
 async function complete(row:ReturnTask){
  if(locks.current.has(row.id))return;
  locks.current.add(row.id);setPending(current=>[...current,row.id]);setError('');
  try{
   await completeDeliveryNotice(row.id,row.item_id);
   completed.current.add(row.id);
   setRows(current=>current.filter(entry=>entry.id!==row.id));
   if(row.kind==='reply')window.location.assign('?itemId='+encodeURIComponent(row.item_id)+'&openMessages=1');
  }catch(cause){setError((cause as {message?:string})?.message||'案内を完了できませんでした。');}
  finally{locks.current.delete(row.id);setPending(current=>current.filter(id=>id!==row.id));}
 }
 useEffect(()=>{
  let active=true,reading=false,queued=false,lastRead=0;
  async function refresh(force=false){
   if(!active)return;
   if(reading){if(force)queued=true;return;}
   if(!force&&Date.now()-lastRead<60000)return;
   reading=true;lastRead=Date.now();
   try{const next=await readResourceSnapshot<ReturnTask>('return_tasks');if(active){setRows(next.filter(row=>!completed.current.has(row.id)&&unexpired(row)));setError('');}}
   catch(cause){if(active)setError((cause as {message?:string})?.message||'差し戻しの案内を読み込めませんでした。');}
   finally{reading=false;if(queued&&active){queued=false;void refresh(true);}}
  }
  const visible=()=>{if(document.visibilityState==='visible')void refresh();};
  const changed=()=>void refresh(true);
  void refresh(true);
  window.addEventListener('focus',visible);document.addEventListener('visibilitychange',visible);
  window.addEventListener('delivery-return-tasks-changed',changed);
  return()=>{active=false;window.removeEventListener('focus',visible);document.removeEventListener('visibilitychange',visible);window.removeEventListener('delivery-return-tasks-changed',changed);};
 },[staffId]);
 useEffect(()=>{
  const next=rows.map(expiry).filter(Number.isFinite).sort((a,b)=>a-b)[0];
  if(next===undefined)return;
  const timer=window.setTimeout(()=>setRows(current=>current.filter(unexpired)),Math.min(2147483647,Math.max(0,next-Date.now())));
  return()=>window.clearTimeout(timer);
 },[rows]);
 return <>{error&&<li className="error" role="alert">{error}</li>}{rows.map(row=>{const productUrl=noticeProductUrl(row.marketplace,row.marketplace_item_id,row.marketplace_url);const inventoryUrl='?itemId='+encodeURIComponent(row.item_id);return <li key={row.id} className={'delivery-return-task'+(row.kind==='shipping'?' delivery-shipping-task':'')}>
  <div className="delivery-return-content"><strong>{row.kind==='shipping'?'発送お願いします。':row.kind==='photo_return'?(row.reason?.trim()||'商品写真の修正お願いします。'):row.kind==='photo_approved'?'出品お願いします。':'動作不良への返信があります。'}</strong>
   <div className="delivery-return-details"><a href={inventoryUrl}>【{row.sku.match(/^([^-]+)-/)?.[1]||row.lot_seq}】</a>
    {productUrl?<a href={productUrl} target="_blank" rel="noopener noreferrer">【{row.marketplace_item_id}】</a>:<span>【{row.marketplace_item_id||'商品ID未登録'}】</span>}<span>{row.sku}</span></div>
  </div>
  <button type="button" className="btn" disabled={pending.includes(row.id)} onClick={()=>void complete(row)}>{pending.includes(row.id)?'更新中…':row.kind==='reply'?'確認':'完了'}</button>
 </li>;})}</>;
}
