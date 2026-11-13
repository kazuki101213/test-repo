import {useEffect,useRef,useState} from 'react';
import {readResourceSnapshot,noticeProductUrl,productModelText,salesChannelLabel} from '@bussan/shared';
import {completeDeliveryNotice} from '../api';
type ReturnTask={id:string;item_id:string;kind:'photo_return'|'photo_approved'|'reply'|'shipping'|'inspection'|'listing_due';created_at?:string;tracking_recorded_at?:string|null;listing_request_title?:string|null;reason?:string|null;sku:string;lot_seq:number;marketplace_item_id:string|null;marketplace:string|null;marketplace_url:string|null;model_no?:string|null;title?:string|null;sales_channel?:string|null;sales_account_label?:string|null};
const taskOrder={inspection:0,photo_approved:1,listing_due:1,shipping:2,photo_return:3,reply:4};
const orderedTasks=(rows:ReturnTask[])=>[...rows].sort((a,b)=>taskOrder[a.kind]-taskOrder[b.kind]||(a.created_at??'').localeCompare(b.created_at??'')||a.id.localeCompare(b.id));
const hour=3_600_000;
const day=24*hour;
const listingTiming={warningHours:120,overdueHours:168,dayOffset:2};
const taskTimings={
 inspection:{warningHours:48,overdueHours:72,dayOffset:1},
 photo_approved:listingTiming,
 listing_due:listingTiming,
 shipping:{warningHours:12,overdueHours:24,dayOffset:0},
 photo_return:null,
 reply:null,
};
function taskTiming(row:ReturnTask,now:number){
 const timing=taskTimings[row.kind];
 const started=Date.parse((row.kind==='shipping'?row.created_at:row.tracking_recorded_at)??'');
 if(!timing||!Number.isFinite(started))return null;
 const warning=started+timing.warningHours*hour;
 const overdue=started+timing.overdueHours*hour;
 if(now<warning)return {tone:undefined,days:0,nextAt:warning};
 const fullDays=Math.floor((now-started)/day);
 const nextDay=started+(fullDays+1)*day;
 return {
  tone:now>=overdue?'overdue':'warning',
  days:fullDays-timing.dayOffset,
  nextAt:now>=overdue?nextDay:Math.min(overdue,nextDay),
 };
}
const taskTitle={inspection:'動作確認お願いします。',photo_approved:'出品お願いします。',listing_due:'出品お願いします。',shipping:'発送お願いします。',reply:'動作不良への返信があります。',photo_return:'商品写真の修正お願いします。'};
function displayTaskTitle(row:ReturnTask){
 switch(row.kind){
  case 'photo_approved':
  case 'listing_due':return row.listing_request_title||taskTitle[row.kind];
  case 'photo_return':return row.reason?.trim()||taskTitle[row.kind];
  case 'shipping':return (row.sales_account_label||salesChannelLabel(row.sales_channel))+taskTitle.shipping;
  default:return taskTitle[row.kind];
 }
}
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
   if(row.kind==='reply')window.location.assign('?itemId='+encodeURIComponent(row.item_id)+'&openComments=1');
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
  const next=rows.reduce((earliest,row)=>Math.min(earliest,taskTiming(row,now)?.nextAt??Infinity),Infinity);
  if(!Number.isFinite(next))return;
  const timer=window.setTimeout(()=>setNow(Date.now()),Math.max(0,next-Date.now()));
  return()=>window.clearTimeout(timer);
 },[rows,now]);
 return <>{error&&<li className="error" role="alert">{error}</li>}{orderedTasks(rows).map(row=>{
  const timing=taskTiming(row,now);
  const tone=timing?.tone;
  if(row.kind==='listing_due'&&!tone)return null;
  const title=displayTaskTitle(row)+(timing&&timing.days>0?`(${timing.days}日経過)`:'');
  const productUrl=noticeProductUrl(row.marketplace,row.marketplace_item_id,row.marketplace_url);
  const inventoryUrl='?itemId='+encodeURIComponent(row.item_id);
  const model=row.kind==='inspection'
   ? productModelText({model_no:row.model_no??null,title:row.title??'',marketplace:row.marketplace??''})
   : '';
  return <li key={row.id} className={'delivery-return-task'+(row.kind==='shipping'?' delivery-shipping-task':'')} data-deadline={tone}>
  <div className="delivery-return-content"><strong>{title}</strong>
   <div className="delivery-return-details"><a href={inventoryUrl}>【{row.sku.match(/^([^-]+)-/)?.[1]||row.lot_seq}】</a>
    {productUrl?<a href={productUrl} target="_blank" rel="noopener noreferrer">【{row.marketplace_item_id}】</a>:<span>【{row.marketplace_item_id||'商品ID未登録'}】</span>}<span>{model&&model!=='—'?`${model}、${row.sku}`:row.sku}</span></div>
  </div>
  {row.kind==='reply'?<button type="button" className="btn" disabled={pending.includes(row.id)} onClick={()=>void complete(row)}>{pending.includes(row.id)?'更新中…':'確認'}</button>:<a className="btn" href={inventoryUrl}>確認</a>}
 </li>;})}</>;
}
