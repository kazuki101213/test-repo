import {useEffect,useRef,useState} from 'react';
import {readResourceSnapshot,noticeProductUrl} from '@bussan/shared';
import {completeDeliveryNotice} from '../api';
type ReturnTask={id:string;item_id:string;kind:'photo_return'|'photo_approved'|'reply'|'shipping'|'inspection'|'listing_due';created_at?:string;tracking_recorded_at?:string|null;listing_request_title?:string|null;reason?:string|null;sku:string;lot_seq:number;marketplace_item_id:string|null;marketplace:string|null;marketplace_url:string|null};
const taskOrder={inspection:0,photo_approved:1,listing_due:1,shipping:2,photo_return:3,reply:4};
const orderedTasks=(rows:ReturnTask[])=>[...rows].sort((a,b)=>taskOrder[a.kind]-taskOrder[b.kind]||(a.created_at??'').localeCompare(b.created_at??'')||a.id.localeCompare(b.id));
const hour=3_600_000;
const deadlineHours={inspection:[48,72],photo_approved:[120,168],listing_due:[120,168],shipping:[12,24],photo_return:[],reply:[]};
function taskDeadlines(row:ReturnTask){
 const started=Date.parse((row.kind==='shipping'?row.created_at:row.tracking_recorded_at)??'');
 return Number.isFinite(started)?deadlineHours[row.kind].map(hours=>started+hours*hour):[];
}
function taskDeadlineTone(row:ReturnTask,now:number){
 const [warning=Infinity,overdue=Infinity]=taskDeadlines(row);
 return now>=overdue?'overdue':now>=warning?'warning':undefined;
}
const taskTitle={inspection:'動作確認お願いします。',photo_approved:'出品お願いします。',listing_due:'出品お願いします。',shipping:'発送お願いします。',reply:'動作不良への返信があります。',photo_return:'商品写真の修正お願いします。'};
const pendingWorkStatuses=['受取前','検品中','商品登録前'];

export default function ReturnTasks({staffId}:{staffId:string}){
 const [rows,setRows]=useState<ReturnTask[]>([]),[error,setError]=useState(''),[pending,setPending]=useState<string[]>([]);
 const [now,setNow]=useState(Date.now());
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
   try{const next=await readResourceSnapshot<ReturnTask>('delivery_work_tasks');if(active){setRows(next.filter(row=>!completed.current.has(row.id)));setNow(Date.now());setError('');}}
   catch(cause){if(active)setError((cause as {message?:string})?.message||'やることを読み込めませんでした。');}
   finally{reading=false;if(queued&&active){queued=false;void refresh(true);}}
  }
  const visible=()=>{if(document.visibilityState==='visible'){setNow(Date.now());void refresh();}};
  const changed=()=>void refresh(true);
  const workflowChanged=(event:Event)=>{
   const item=(event as CustomEvent<{id:string;status:string;inspected?:boolean;malfunction_reported?:boolean;product_registered_at?:string|null;listed_on?:string|null;shipped_on?:string|null;sold_on?:string|null}>).detail;
   if(!item)return;
   setRows(current=>current.filter(row=>{
    if(row.item_id!==item.id)return true;
    switch(row.kind){
     case 'inspection':return ['受取前','検品中'].includes(item.status)&&!item.inspected&&!item.malfunction_reported;
     case 'listing_due':return pendingWorkStatuses.includes(item.status)&&!item.listed_on&&!item.sold_on;
     case 'photo_approved':return item.status==='商品登録前'&&!item.product_registered_at&&!item.sold_on;
     case 'shipping':return ['取引中','販売済'].includes(item.status)&&!item.shipped_on;
     default:return true;
    }
   }));
  };
  void refresh(true);
  window.addEventListener('focus',visible);document.addEventListener('visibilitychange',visible);
  window.addEventListener('delivery-return-tasks-changed',changed);window.addEventListener('delivery-item-workflow-changed',workflowChanged);
  return()=>{active=false;window.removeEventListener('focus',visible);document.removeEventListener('visibilitychange',visible);window.removeEventListener('delivery-return-tasks-changed',changed);window.removeEventListener('delivery-item-workflow-changed',workflowChanged);};
 },[staffId]);
 useEffect(()=>{
  const next=Math.min(...rows.flatMap(taskDeadlines).filter(deadline=>deadline>now));
  if(!Number.isFinite(next))return;
  const timer=window.setTimeout(()=>setNow(Date.now()),Math.max(0,next-Date.now()));
  return()=>window.clearTimeout(timer);
 },[rows,now]);
 return <>{error&&<li className="error" role="alert">{error}</li>}{orderedTasks(rows).map(row=>{
  const tone=taskDeadlineTone(row,now);
  const title=row.kind==='photo_approved'||row.kind==='listing_due'
    ? row.listing_request_title||taskTitle[row.kind]
    : row.kind==='photo_return'&&row.reason?.trim()||taskTitle[row.kind];
  if(row.kind==='listing_due'&&!tone)return null;
  const productUrl=noticeProductUrl(row.marketplace,row.marketplace_item_id,row.marketplace_url);
  const inventoryUrl='?itemId='+encodeURIComponent(row.item_id);
  return <li key={row.id} className={'delivery-return-task'+(row.kind==='shipping'?' delivery-shipping-task':'')} data-deadline={tone}>
  <div className="delivery-return-content"><strong>{title}</strong>
   <div className="delivery-return-details"><a href={inventoryUrl}>【{row.sku.match(/^([^-]+)-/)?.[1]||row.lot_seq}】</a>
    {productUrl?<a href={productUrl} target="_blank" rel="noopener noreferrer">【{row.marketplace_item_id}】</a>:<span>【{row.marketplace_item_id||'商品ID未登録'}】</span>}<span>{row.sku}</span></div>
  </div>
  {row.kind==='reply'?<button type="button" className="btn" disabled={pending.includes(row.id)} onClick={()=>void complete(row)}>{pending.includes(row.id)?'更新中…':'確認'}</button>:<a className="btn" href={inventoryUrl}>確認</a>}
 </li>;})}</>;
}
