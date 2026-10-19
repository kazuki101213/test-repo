import {useEffect,useState} from 'react';
import {readResourceSnapshot,noticeProductUrl} from '@bussan/shared';
type ReturnTask={id:string;item_id:string;kind:'photo_return'|'photo_approved'|'reply';expires_at:string;sku:string;lot_seq:number;marketplace_item_id:string|null;marketplace:string|null;marketplace_url:string|null};
export default function ReturnTasks({staffId}:{staffId:string}){
 const [rows,setRows]=useState<ReturnTask[]>([]),[error,setError]=useState(''),[now,setNow]=useState(Date.now());
 useEffect(()=>{const next=Math.min(...rows.map(row=>Date.parse(row.expires_at)).filter(at=>at>now));if(!Number.isFinite(next))return;const timer=window.setTimeout(()=>setNow(Date.now()),Math.max(1,next-Date.now()+10));return()=>window.clearTimeout(timer);},[rows,now]);
 useEffect(()=>{
  let active=true,reading=false,queued=false,lastRead=0;
  async function refresh(force=false){
   if(!active)return;
   if(reading){if(force)queued=true;return;}
   if(!force&&Date.now()-lastRead<60000)return;
   reading=true;lastRead=Date.now();
   try{const next=await readResourceSnapshot<ReturnTask>('return_tasks');if(active){setRows(next);setNow(Date.now());setError('');}}
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
 return <>{error&&<li className="error" role="alert">{error}</li>}{rows.filter(row=>Date.parse(row.expires_at)>now).map(row=>{const productUrl=noticeProductUrl(row.marketplace,row.marketplace_item_id,row.marketplace_url);const inventoryUrl='?itemId='+encodeURIComponent(row.item_id);return <li key={row.id} className="delivery-return-task">
  <div className="delivery-return-content"><strong>{row.kind==='photo_return'?'商品写真の修正お願いします。':row.kind==='photo_approved'?'商品写真承認されました。':'動作不良への返信があります。'}</strong>
   <div className="delivery-return-details"><a href={inventoryUrl}>【{row.sku.match(/^([^-]+)-/)?.[1]||row.lot_seq}】</a>
    {productUrl?<a href={productUrl} target="_blank" rel="noopener noreferrer">【{row.marketplace_item_id}】</a>:<span>【{row.marketplace_item_id||'商品ID未登録'}】</span>}<span>{row.sku}</span></div>
  </div>
  <a className="btn" href={'?itemId='+encodeURIComponent(row.item_id)+(row.kind==='reply'?'&openMessages=1':'')}>確認</a>
 </li>;})}</>;
}
