import {useEffect,useState} from 'react';
import {readResourceSnapshot} from '@bussan/shared';
import {purchaseItemUrl} from '../purchaseUrl';
import {productSerial} from '../inventory';
import {deliveryAppUrl} from '../appUrls';
type ShippingReminder={id:string;item_id:string;sku:string;lot_seq:number;sales_channel:string;marketplace:string|null;marketplace_item_id:string|null;marketplace_url:string|null};
export default function ShippingReminderTasks(){
 const [rows,setRows]=useState<ShippingReminder[]>([]),[error,setError]=useState('');
 useEffect(()=>{
  let active=true,reading=false,lastRead=-Infinity;
  async function refresh(){
   if(reading||document.visibilityState==='hidden')return;reading=true;lastRead=Date.now();
   try{const next=await readResourceSnapshot<ShippingReminder>('admin_shipping_tasks');if(active){setRows(next);setError('');}}
   catch(cause){if(active)setError((cause as {message?:string})?.message||'発送待ちを読み込めませんでした。');}
   finally{reading=false;}
  }
  const visible=()=>{if(Date.now()-lastRead>=30000)void refresh();};
  void refresh();const timer=window.setInterval(visible,300000);
  window.addEventListener('focus',visible);document.addEventListener('visibilitychange',visible);
  return()=>{active=false;window.clearInterval(timer);window.removeEventListener('focus',visible);document.removeEventListener('visibilitychange',visible);};
 },[]);
 return <>{error&&<li className="error" role="alert">{error}</li>}{rows.map(row=>{const inventory=deliveryAppUrl+'?itemId='+encodeURIComponent(row.item_id);const product=purchaseItemUrl(row.marketplace,row.marketplace_item_id,row.marketplace_url);return <li key={row.id} className="admin-task-card admin-simple-task admin-shipping-reminder">
  <div className="task-action-details listing-task-details"><strong>{row.sales_channel}発送</strong><a href={inventory} target="_blank" rel="noopener noreferrer" aria-label="発送する商品の在庫を開く">【{productSerial(row.sku,row.lot_seq)}】</a>{product?<a href={product} target="_blank" rel="noopener noreferrer">【{row.marketplace_item_id}】</a>:<span>【{row.marketplace_item_id||'商品ID未登録'}】</span>}<small>{row.sku}</small></div>
  <a className="btn" href={inventory} target="_blank" rel="noopener noreferrer">確認</a>
 </li>;})}</>;
}
