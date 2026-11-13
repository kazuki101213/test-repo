import {useEffect,useState} from 'react';
import {productModelText,readResourceSnapshot} from '@bussan/shared';
import {purchaseItemUrl} from '../purchaseUrl';
import {productSerial} from '../inventory';
import {deliveryAppUrl} from '../appUrls';
type ShippingReminder={id:string;item_id:string;action_item_id?:string;sku:string;lot_seq:number;sales_channel:string;marketplace:string|null;marketplace_item_id:string|null;marketplace_url:string|null;created_at?:string;purchase_account_label?:string|null;model_no?:string|null;title?:string;waiting_for_parts?:boolean};
const DAY_MS=24*60*60*1000;

function inspectionReminderDays(trackingRecordedAt:string|undefined,checkedAt:number){
 const recordedAt=trackingRecordedAt?Date.parse(trackingRecordedAt):NaN;
 if(!Number.isFinite(recordedAt))return 2;
 // The card appears after three full days and starts at “2日経過”.
 return Math.max(2,Math.floor((checkedAt-recordedAt)/DAY_MS)-1);
}

export default function ShippingReminderTasks({kind='shipping'}:{kind?:'shipping'|'inspection'}={}){
 const [{rows,checkedAt},setSnapshot]=useState<{rows:ShippingReminder[];checkedAt:number}>({rows:[],checkedAt:0});
 const [error,setError]=useState('');
 useEffect(()=>{
  let active=true,reading=false,lastRead=-Infinity;
  async function refresh(){
   if(reading||document.visibilityState==='hidden')return;reading=true;lastRead=Date.now();
   try{const next=await readResourceSnapshot<ShippingReminder>(kind==='inspection'?'admin_inspection_tasks':'admin_shipping_tasks');if(active){setSnapshot({rows:next,checkedAt:Date.now()});setError('');}}
   catch(cause){if(active)setError((cause as {message?:string})?.message||(kind==='inspection'?'動作確認待ちを読み込めませんでした。':'発送待ちを読み込めませんでした。'));}
   finally{reading=false;}
  }
  const visible=()=>{if(Date.now()-lastRead>=30000)void refresh();};
  void refresh();const timer=window.setInterval(visible,300000);
  window.addEventListener('focus',visible);document.addEventListener('visibilitychange',visible);
  return()=>{active=false;window.clearInterval(timer);window.removeEventListener('focus',visible);document.removeEventListener('visibilitychange',visible);};
 },[kind]);
 return <>{error&&<li className="error" role="alert">{error}</li>}{rows.map(row=>{
  const inspection=kind==='inspection';
  const inventory=deliveryAppUrl+'?itemId='+encodeURIComponent(row.item_id);
  const product=purchaseItemUrl(row.marketplace,row.marketplace_item_id,row.marketplace_url);
  const supplier=row.purchase_account_label || row.marketplace || '仕入先未登録';
  const model=inspection?productModelText({model_no:row.model_no??null,title:row.title??'',marketplace:row.marketplace??''}):'';
  const pendingParts=inspection&&row.waiting_for_parts;
  return <li key={row.id} className="admin-task-card admin-simple-task admin-shipping-reminder admin-task-overdue">
  <div className="task-action-details listing-task-details">
   <strong title={pendingParts?'本体・付属品の追跡番号または到着確認がそろっていません。':undefined}>{inspection?`動作確認${supplier}(${inspectionReminderDays(row.created_at,checkedAt)}日経過)${pendingParts?'※':''}`:row.sales_channel+'発送(24時間経過)'}</strong>
   <a href={inventory} target="_blank" rel="noopener noreferrer" aria-label={inspection?'動作確認する商品の在庫を開く':'発送する商品の在庫を開く'}>【{productSerial(row.sku,row.lot_seq)}】</a>
   {product?<a href={product} target="_blank" rel="noopener noreferrer">【{row.marketplace_item_id}】</a>:<span>【{row.marketplace_item_id||'商品ID未登録'}】</span>}
   <small>{inspection?`${model==='—'?'型番未登録':model}、${row.sku}`:row.sku}</small>
  </div>
  <a className="btn" href={deliveryAppUrl+'?itemId='+encodeURIComponent(row.action_item_id ?? row.item_id)} target="_blank" rel="noopener noreferrer">確認</a>
 </li>;})}</>;
}
