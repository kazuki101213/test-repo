import PackingPhotoTasks from './PackingPhotoTasks';
import { readResourceSnapshot, staffDisplayName, deliveryStaffOptions } from '@bussan/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getSupabase, yen } from '@bussan/shared';
import type { InvoiceReceipt, Staff } from '@bussan/shared';
import MalfunctionTasks from './MalfunctionTasks';
import SpareShippingTasks from './SpareShippingTasks';
import PackedSummary from './PackedSummary';
import PhotoReviewTasks from './PhotoReviewTasks';
import ShippingReminderTasks from './ShippingReminderTasks';
import ReceiptEvaluationTasks from './ReceiptEvaluationTasks';
import { adminTaskNotice } from '../taskNotice';
import DeliveryInvoices from '../../../delivery/src/pages/Invoices';
import type { InvoiceReviewState } from '../../../delivery/src/pages/Invoices';
import type { InvoiceSnapshot } from '../../../delivery/src/invoices';
import './InvoiceReview.css';


interface Approval { approved_at:string; expense_id:string }
interface Invoice {
 id:string; staff_id:string; billing_month:string; issued_on:string; total:number; version:number; updated_at:string; note:string;
 snapshot:InvoiceSnapshot;
 delivery_invoice_approvals:Approval|Approval[]|null;
}
interface Submission {staff_id:string;billing_month:string;files:Omit<InvoiceReceipt,'url'>[];version:number;submitted_at:string}
interface Person {staff_id:string;details:{issuer_name:string}}
interface Task {id:string;staff_id:string;month:string;name:string;updated:string;invoice?:Invoice;receipts?:Submission}
const approval=(row?:Invoice)=>row?(Array.isArray(row.delivery_invoice_approvals)?row.delivery_invoice_approvals[0]:row.delivery_invoice_approvals):null;
const messageOf=(e:unknown)=>e instanceof Error?e.message:(e as {message?:string})?.message??'処理に失敗しました。';
const monthEnd=(month:string)=>{const date=new Date(month+'T00:00:00Z');date.setUTCMonth(date.getUTCMonth()+1,0);return date.toISOString().slice(0,10);};

async function fetchTasks():Promise<Task[]> {
 return [...await readResourceSnapshot<Task>('invoice_tasks')].sort((a,b)=>b.updated.localeCompare(a.updated));
}

const ignoreInvoiceNavigation = () => {};
function InvoiceReview({task,staff,onClose,onApproved,onSaved}:{task:Task;staff:Staff;onClose:()=>void;onApproved:()=>void;onSaved?:()=>void}) {
 const dialog=useRef<HTMLDialogElement>(null);
 const [busy,setBusy]=useState(false);const [error,setError]=useState('');
 const [documents,setDocuments]=useState<InvoiceReviewState>({invoice:null,receiptVersion:task.receipts?.version??null,busy:false,dirty:false,ready:false});
 const updateDocuments=useCallback((state:InvoiceReviewState)=>setDocuments(state),[]);
 const invoice=documents.invoice;const approved=approval(task.invoice)||invoice?.approved_at;
 const close=()=>{if(busy||documents.busy)return;if(documents.dirty&&!window.confirm('保存していない変更を破棄しますか？'))return;onClose();};
 useEffect(()=>{const el=dialog.current;el?.showModal();return()=>el?.close();},[]);
 async function approve(){
  if(!invoice||!documents.ready||documents.dirty||busy||documents.busy)return;
  setBusy(true);setError('');
  try{
   const {error}=await getSupabase().rpc('approve_invoice_documents',{p_invoice:invoice.id,p_version:invoice.version,p_receipt_version:documents.receiptVersion,p_incurred_on:monthEnd(task.month)});
   if(error)throw error;onApproved();
  }catch(e){setError(messageOf(e));}finally{setBusy(false);}
 }
 return <dialog ref={dialog} className="monthly-detail invoice-review" aria-labelledby="invoice-review-title" onCancel={e=>{e.preventDefault();close();}}>
  <div className="toolbar"><h2 id="invoice-review-title">{staffDisplayName(task.name)} · {task.month.slice(0,7)}</h2><span style={{flex:1}}/><button className="btn" disabled={busy||documents.busy} onClick={close} autoFocus>閉じる</button></div>
  <fieldset className="invoice-review-content" disabled={busy}><DeliveryInvoices staff={staff} onNavigationChange={ignoreInvoiceNavigation} review={{staffId:task.staff_id,month:task.month.slice(0,7),receiptVersion:task.receipts?.version??null,onStateChange:updateDocuments,onSaved}}/></fieldset>
  {error&&<div className="error" role="alert">{error}</div>}
  <div className="toolbar invoice-review-approval">{!approved&&<button className="btn primary" disabled={busy||documents.busy||documents.dirty||!documents.ready||!invoice||invoice.total<=0} onClick={()=>void approve()}>{busy?'承認中…':'承認'}</button>}<button className="btn" disabled={busy||documents.busy} onClick={close}>閉じる</button></div>
 </dialog>;
}

export default function InvoiceTasks({onApproved,staff}:{onApproved:()=>void;staff:Staff}){
 const notice=adminTaskNotice();const noticeHandled=useRef(false);
 const [rows,setRows]=useState<Task[]>([]);const [selected,setSelected]=useState<Task|null>(null);
 const [error,setError]=useState('');const [message,setMessage]=useState('');const [loading,setLoading]=useState(true);const [revision,setRevision]=useState(0);
 const [photoRevision,setPhotoRevision]=useState(0);
 useEffect(()=>{
  let active=true;let fetching=false;
  const refresh=async()=>{if(fetching)return;fetching=true;try{const data=await fetchTasks();if(active){setRows(data);setError('');}}catch(e){if(active)setError(messageOf(e));}finally{fetching=false;if(active)setLoading(false);}};
  void refresh();const timer=window.setInterval(()=>{if(document.visibilityState==='visible')void refresh();},300000);
  return()=>{active=false;window.clearInterval(timer);};
 },[revision]);
 useEffect(()=>{
  if(loading||noticeHandled.current||!notice||!['invoice','receipts'].includes(notice.kind))return;
  noticeHandled.current=true;
  const target=rows.find(row=>row.staff_id===notice.invoiceStaffId&&row.month===notice.billingMonth);
  if(target)setSelected(target);
  else setMessage('通知の書類確認タスクは現在確認できません。');
 },[loading,rows]);
 const filtered=rows.filter(row=>!approval(row.invoice));
 return <section className="card invoice-tasks" aria-label="やること">
 {error&&<div className="error" role="alert">{error}<button className="btn" onClick={()=>setRevision(n=>n+1)}>再読み込み</button></div>}{message&&<p className="ok" role="status">{message}</p>}
 {loading?<p>読み込み中…</p>:<ul className="invoice-task-rows">{filtered.map(row=><li key={row.id} className="admin-task-card admin-simple-task admin-invoice-task"><div className="task-action-details"><strong>{row.invoice?'請求書':'領収書'}</strong><span>【{staffDisplayName(row.name)}】</span><span>【{row.month.slice(0,7)}】</span><small>{row.invoice?yen(row.invoice.total):'領収書のみ'}</small></div><button type="button" className="btn" onClick={()=>setSelected(row)}>確認</button></li>)}<PhotoReviewTasks mode="photos" onReviewed={()=>setPhotoRevision(value=>value+1)}/>{staff.role==='admin'&&<PackingPhotoTasks/>}<MalfunctionTasks staff={staff} /><ReceiptEvaluationTasks/><PhotoReviewTasks mode="listing" refreshRevision={photoRevision}/><ShippingReminderTasks /><SpareShippingTasks staff={staff} management /></ul>}
 {selected&&<InvoiceReview key={selected.id} task={selected} staff={staff} onClose={()=>setSelected(null)} onSaved={()=>setRevision(n=>n+1)} onApproved={()=>{setSelected(null);setRevision(n=>n+1);setMessage('承認し、経費の外注費に追加しました。');onApproved();}}/>}
 </section>;
}

export function AdminPackedSummary(){
 const [people,setPeople]=useState<Person[]>([]);const [staffId,setStaffId]=useState('');const [error,setError]=useState('');
 useEffect(()=>{let active=true;void(async()=>{
  const {data,error}=await getSupabase().from('staff').select('id,code,name').eq('is_active',true);if(error)throw error;
  if(active){const rows=deliveryStaffOptions(data).map(p=>({staff_id:p.id,details:{issuer_name:p.name}}));setPeople(rows);setStaffId(rows[0]?.staff_id??'');}
 })().catch(e=>{if(active)setError(messageOf(e));});return()=>{active=false;};},[]);
 return <section className="card" style={{marginTop:16}}><h3>担当者別の納品実績</h3>{error&&<p className="error">{error}</p>}<label>担当者 <select value={staffId} onChange={e=>setStaffId(e.target.value)}>{people.map(p=><option key={p.staff_id} value={p.staff_id}>{staffDisplayName(p.details.issuer_name)}</option>)}</select></label>{staffId&&<PackedSummary staffId={staffId}/>}</section>;
}
