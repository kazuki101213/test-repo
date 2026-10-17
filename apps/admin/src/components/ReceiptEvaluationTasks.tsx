import {useEffect,useRef,useState} from 'react';
import {getSupabase,readResourceSnapshot} from '@bussan/shared';
import {deliveryAppUrl} from '../appUrls';
import {receiptTransactionUrl} from '../receiptEvaluation';
import './receiptEvaluationTasks.css';

interface ReceiptTask {id:string;item_id:string;sku:string;lot_seq:number;title:string;model_no:string|null;asin:string|null;marketplace:string;marketplace_item_id:string|null;marketplace_url:string|null;requested_at:string}
function ExternalIcon(){return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M14 3h7v7M21 3l-11 11M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5"/></svg>;}
export default function ReceiptEvaluationTasks(){
 const [rows,setRows]=useState<ReceiptTask[]>([]),[error,setError]=useState(''),[busy,setBusy]=useState<string|null>(null),[revision,setRevision]=useState(0);
 const lock=useRef(false);
 useEffect(()=>{let active=true,inFlight=false;
  async function refresh(){if(inFlight||document.visibilityState==='hidden')return;inFlight=true;try{const data=await readResourceSnapshot<ReceiptTask>('receipt_tasks');if(active){setRows([...data].sort((a,b)=>a.requested_at.localeCompare(b.requested_at)));setError('');}}catch(cause){if(active)setError(cause instanceof Error?cause.message:String(cause));}finally{inFlight=false;}}
  void refresh();const timer=window.setInterval(()=>void refresh(),30000);window.addEventListener('focus',refresh);return()=>{active=false;window.clearInterval(timer);window.removeEventListener('focus',refresh);};
 },[revision]);
 async function complete(row:ReceiptTask){if(lock.current||busy||!window.confirm('フリマサイトで受取評価が完了していることを確認しましたか？'))return;lock.current=true;setBusy(row.id);setError('');try{const {error}=await getSupabase().rpc('complete_receipt_evaluation_task',{p_item_id:row.item_id});if(error)throw error;setRows(current=>current.filter(value=>value.id!==row.id));setRevision(value=>value+1);}catch(cause){setError(cause instanceof Error?cause.message:String(cause));}finally{lock.current=false;setBusy(null);}}
 return <>{error&&<li className="error" role="alert">{error}</li>}{rows.map(row=>{const transaction=receiptTransactionUrl(row.marketplace,row.marketplace_item_id,row.marketplace_url);return <li key={row.id} className="receipt-evaluation-task">
  <p>受取評価をしてください。</p><div className="receipt-evaluation-info"><span>通番号 {row.lot_seq}</span><span>SKU {row.sku}</span><span>商品 {row.model_no||row.title}</span><span>仕入先 {row.marketplace}</span><span>商品ID {row.marketplace_item_id||'未登録'}</span></div>
  <div className="receipt-evaluation-actions"><a className="btn" href={deliveryAppUrl+'?itemId='+encodeURIComponent(row.item_id)} target="_blank" rel="noreferrer" aria-label="商品の詳細を開く" title="商品詳細"><ExternalIcon/></a>{transaction?<a className="btn" href={transaction} target="_blank" rel="noreferrer" aria-label="仕入先の取引画面を開く" title={row.marketplace+'の取引画面'}><ExternalIcon/></a>:<button type="button" className="btn" disabled title="商品ID・仕入先URLを確認してください" aria-label="仕入先の取引画面を開く"><ExternalIcon/></button>}<button type="button" className="btn" disabled={busy!==null} onClick={()=>void complete(row)}>{busy===row.id?'更新中…':'受取評価済み'}</button></div>
 </li>;})}</>;
}
