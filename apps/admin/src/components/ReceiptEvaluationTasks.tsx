import { productSerial } from '../inventory';
import { useTaskConfirmation } from './TaskConfirmation';
import {useEffect,useRef,useState} from 'react';
import {getSupabase,readResourceSnapshot} from '@bussan/shared';
import {deliveryAppUrl} from '../appUrls';
import {receiptTransactionUrl} from '../receiptEvaluation';
import './receiptEvaluationTasks.css';

interface ReceiptTask {id:string;item_id:string;sku:string;lot_seq:number;title:string;model_no:string|null;asin:string|null;marketplace:string;marketplace_item_id:string|null;marketplace_url:string|null;requested_at:string;is_accessory?:boolean}
export default function ReceiptEvaluationTasks(){
 const [rows,setRows]=useState<ReceiptTask[]>([]),[error,setError]=useState(''),[busy,setBusy]=useState<string|null>(null),[revision,setRevision]=useState(0);
 const lock=useRef(false);
 const {ask,pending,confirmation}=useTaskConfirmation();
 useEffect(()=>{let active=true,inFlight=false;
  async function refresh(){if(inFlight||document.visibilityState==='hidden')return;inFlight=true;try{const data=await readResourceSnapshot<ReceiptTask>('receipt_tasks');if(active){setRows([...data].sort((a,b)=>a.requested_at.localeCompare(b.requested_at)));setError('');}}catch(cause){if(active)setError(cause instanceof Error?cause.message:String(cause));}finally{inFlight=false;}}
  void refresh();const timer=window.setInterval(()=>void refresh(),300000);window.addEventListener('focus',refresh);return()=>{active=false;window.clearInterval(timer);window.removeEventListener('focus',refresh);};
 },[revision]);
 async function complete(row:ReceiptTask){if(lock.current||busy)return;lock.current=true;setBusy(row.id);setError('');try{const {error}=await getSupabase().rpc('complete_receipt_evaluation_task',{p_item_id:row.item_id});if(error)throw error;setRows(current=>current.filter(value=>value.id!==row.id));setRevision(value=>value+1);}catch(cause){setError(cause instanceof Error?cause.message:String(cause));}finally{lock.current=false;setBusy(null);}}
 return <>{error&&<li className="error" role="alert">{error}</li>}{rows.map(row=>{const transaction=receiptTransactionUrl(row.marketplace,row.marketplace_item_id,row.marketplace_url);return <li key={row.id} className="admin-task-card admin-simple-task receipt-evaluation-task">
  <div className="task-action-details"><strong>{row.is_accessory?'受取評価（付属品）':'受取評価'}</strong><a href={deliveryAppUrl+'?itemId='+encodeURIComponent(row.item_id)} target="_blank" rel="noopener noreferrer" aria-label="商品の詳細を開く">【{productSerial(row.sku,row.lot_seq)}】</a>{transaction?<a href={transaction} target="_blank" rel="noopener noreferrer" aria-label="仕入先の取引画面を開く">【{row.marketplace_item_id||'商品ID未登録'}】</a>:<span>【{row.marketplace_item_id||'商品ID未登録'}】</span>}<small>{row.sku}</small></div>
  <button type="button" className="btn" disabled={busy!==null||pending} onClick={()=>ask('受取評価：完了',()=>complete(row),'フリマサイトで受取評価が完了していることを確認してください。この操作はアプリ内のやることを完了します。')}>{busy===row.id?'更新中…':'完了'}</button>
 </li>;})}{confirmation}</>;
}
