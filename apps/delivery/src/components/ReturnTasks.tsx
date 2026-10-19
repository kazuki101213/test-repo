import {useEffect,useState} from 'react';
import {readResourceSnapshot} from '@bussan/shared';
type ReturnTask={id:string;item_id:string;kind:'photo_return'|'malfunction_return';reason:string;sku:string;lot_seq:number;marketplace_item_id:string|null};
export default function ReturnTasks({staffId}:{staffId:string}){
 const [rows,setRows]=useState<ReturnTask[]>([]),[error,setError]=useState('');
 useEffect(()=>{
  let active=true,reading=false,queued=false,lastRead=0;
  async function refresh(force=false){
   if(!active)return;
   if(reading){if(force)queued=true;return;}
   if(!force&&Date.now()-lastRead<60000)return;
   reading=true;lastRead=Date.now();
   try{const next=await readResourceSnapshot<ReturnTask>('return_tasks');if(active){setRows(next);setError('');}}
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
 return <>{error&&<li className="error" role="alert">{error}</li>}{rows.map(row=><li key={row.id} className="delivery-return-task">
  <strong>{row.kind==='photo_return'?'写真の差し戻し':'報告の差し戻し'}</strong>
  <div className="delivery-return-details"><a href={'?itemId='+encodeURIComponent(row.item_id)}>【{row.sku.match(/^([^-]+)-/)?.[1]||row.lot_seq}】</a>
   <span>【{row.marketplace_item_id||'商品ID未登録'}】</span><span>{row.sku}</span></div>
  <p className="delivery-return-reason">差し戻し理由：{row.reason}</p>
  <p>{row.kind==='photo_return'?'写真を修正して再提出してください。':'検品内容を確認し、再報告または検品完了を行ってください。'}</p>
 </li>)}</>;
}
