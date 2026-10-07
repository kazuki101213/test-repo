import { staffDisplayName } from '@bussan/shared';
import { useEffect, useRef, useState } from 'react';
import { getSupabase, yen, loadInvoiceReceipts, releaseReceiptImages } from '@bussan/shared';
import type { InvoiceReceipt, Staff } from '@bussan/shared';
import MalfunctionTasks from './MalfunctionTasks';
import PackedSummary from './PackedSummary';
import PhotoReviewTasks from './PhotoReviewTasks';

interface Line { date:string|null; description:string; quantity:number; unit_price:number; lot_seq?:number }
interface Approval { approved_at:string; expense_id:string }
interface Invoice {
 id:string; staff_id:string; billing_month:string; issued_on:string; total:number; version:number; updated_at:string; note:string;
 snapshot:{profile:Record<string,string>;lines:Line[];extras:Line[]};
 delivery_invoice_approvals:Approval|Approval[]|null;
}
interface Submission {staff_id:string;billing_month:string;files:Omit<InvoiceReceipt,'url'>[];version:number;submitted_at:string}
interface Task {id:string;staff_id:string;month:string;name:string;updated:string;invoice?:Invoice;receipts?:Submission}
interface Person {staff_id:string;details:{issuer_name:string}}
const approval=(row?:Invoice)=>row?(Array.isArray(row.delivery_invoice_approvals)?row.delivery_invoice_approvals[0]:row.delivery_invoice_approvals):null;
const messageOf=(e:unknown)=>e instanceof Error?e.message:(e as {message?:string})?.message??'処理に失敗しました。';
const monthEnd=(month:string)=>{const date=new Date(month+'T00:00:00Z');date.setUTCMonth(date.getUTCMonth()+1,0);return date.toISOString().slice(0,10);};

async function fetchTasks():Promise<Task[]> {
 const invoices:Invoice[]=[]; const submissions:Submission[]=[];
 for(let start=0;;start+=500){
  const {data,error}=await getSupabase().from('delivery_invoices').select('id,staff_id,billing_month,issued_on,total,version,updated_at,note,snapshot,delivery_invoice_approvals(approved_at,expense_id)').order('id').range(start,start+499);
  if(error)throw error;invoices.push(...data as unknown as Invoice[]);if(data.length<500)break;
 }
 for(let start=0;;start+=500){
  const {data,error}=await getSupabase().from('invoice_receipt_submissions').select('*').order('staff_id').order('billing_month').range(start,start+499);
  if(error)throw error;submissions.push(...data as Submission[]);if(data.length<500)break;
 }
 const {data:profiles,error}=await getSupabase().from('delivery_invoice_profiles').select('staff_id,details');
 if(error)throw error;
 const names=new Map((profiles as Person[]).map(p=>[p.staff_id,p.details.issuer_name]));
 const tasks=new Map<string,Task>();
 for(const inv of invoices){const id=inv.staff_id+'/'+inv.billing_month;tasks.set(id,{id,staff_id:inv.staff_id,month:inv.billing_month,name:inv.snapshot.profile.issuer_name ?? '担当者',updated:inv.updated_at,invoice:inv});}
 for(const rec of submissions){const id=rec.staff_id+'/'+rec.billing_month;const task=tasks.get(id)??{id,staff_id:rec.staff_id,month:rec.billing_month,name:names.get(rec.staff_id)??'担当者',updated:rec.submitted_at};task.receipts=rec;if(rec.submitted_at>task.updated)task.updated=rec.submitted_at;tasks.set(id,task);}
 return [...tasks.values()].sort((a,b)=>b.updated.localeCompare(a.updated));
}

function InvoiceReview({ task,onClose,onApproved }:{task:Task;onClose:()=>void;onApproved:()=>void}) {
 const dialog=useRef<HTMLDialogElement>(null);
 const [date,setDate]=useState(()=>monthEnd(task.month));
 const [busy,setBusy]=useState(false);const [error,setError]=useState('');
 const [images,setImages]=useState<InvoiceReceipt[]>([]);const [imagesLoading,setImagesLoading]=useState(true);const [imageError,setImageError]=useState('');
 const invoice=task.invoice;const p=invoice?.snapshot.profile;const approved=approval(invoice);
 const lines=invoice?[...invoice.snapshot.lines,...invoice.snapshot.extras]:[];
 useEffect(()=>{const el=dialog.current;el?.showModal();return()=>el?.close();},[]);
 useEffect(()=>{
  let active=true;let loaded:InvoiceReceipt[]=[];setImagesLoading(true);setImageError('');
  void loadInvoiceReceipts(task.staff_id,task.month.slice(0,7)).then(rows=>{loaded=rows;if(active)setImages(rows);else releaseReceiptImages(rows);})
   .catch(e=>{if(active)setImageError(messageOf(e));}).finally(()=>{if(active)setImagesLoading(false);});
  return()=>{active=false;releaseReceiptImages(loaded);};
 },[task.staff_id,task.month]);
 async function approve(){
  if(!invoice)return;setBusy(true);setError('');
  try{
   const {error}=await getSupabase().rpc('approve_invoice_documents',{p_invoice:invoice.id,p_version:invoice.version,p_receipt_version:task.receipts?.version??null,p_incurred_on:date});
   if(error)throw error;onApproved();
  }catch(e){setError(messageOf(e));}finally{setBusy(false);}
 }
 return <dialog ref={dialog} className="monthly-detail invoice-review" aria-labelledby="invoice-review-title" onCancel={e=>{if(busy)e.preventDefault();else onClose();}}>
 <div className="toolbar"><h2 id="invoice-review-title">{staffDisplayName(task.name)} · {task.month.slice(0,7)}</h2><span style={{flex:1}}/><button className="btn" disabled={busy} onClick={onClose} autoFocus>閉じる</button></div>
 <div className="document-review-columns"><section><h3>請求書</h3>
 {invoice?<><p>請求日：{invoice.issued_on}　請求金額：<strong>{yen(invoice.total)}</strong>　{approved?'承認済み':'承認待ち'}</p>
 <div className="scroll" style={{maxHeight:'55vh'}}><table><thead><tr><th>購入日／日付</th><th>内容</th><th>数量</th><th>単価</th><th>金額</th></tr></thead><tbody>{lines.map((line,i)=><tr key={i}><td>{line.date??'—'}</td><td>{line.description}{line.lot_seq!=null&&'（'+line.lot_seq+'）'}</td><td>{line.quantity}</td><td>{yen(line.unit_price)}</td><td>{yen(line.quantity*line.unit_price)}</td></tr>)}</tbody></table></div>
 {invoice.note&&<p style={{whiteSpace:'pre-wrap'}}>{invoice.note}</p>}
 {p&&<details><summary>請求者・振込先</summary><p style={{whiteSpace:'pre-line'}}>{p.issuer_name}<br/>{p.postal} {p.address}<br/>{p.phone} / {p.email}<br/>{p.bank}（{p.bank_code}） {p.branch}（{p.branch_code}）<br/>{p.account_type} {p.account_number}<br/>{p.holder}<br/>{p.holder_kana}</p></details>}
 </>:<p>請求書はまだ送信されていません。</p>}</section>
 <section><h3>請求書・領収書の添付</h3>{imagesLoading&&<p>読み込み中…</p>}{imageError&&<p className="error">{imageError}</p>}{!imagesLoading&&!images.length&&<p>添付ファイルはありません。</p>}
 <div className="review-receipts">{images.map((image,i)=><a key={image.id} href={image.url} target="_blank" rel="noreferrer" title="クリックして開く">{image.mime_type.startsWith('image/')?<img src={image.url} alt={image.original_name}/>:<span className="receipt-pdf-link">PDFを開く</span>}<span>{image.document_type==='invoice'?'請求書':image.document_type==='receipt'?'領収書':'領収書の写真'}：{image.original_name}</span></a>)}</div></section></div>
 <PackedSummary staffId={task.staff_id} initialMonth={task.month.slice(0,7)} billedCount={invoice?.snapshot.lines.reduce((n,l)=>n+l.quantity,0)}/>
 {error&&<div className="error" role="alert">{error}</div>}
 {invoice&&!approved&&<form onSubmit={e=>{e.preventDefault();void approve();}}><div className="toolbar"><label className="field"><span>経費の計上日</span><input type="date" required value={date} disabled={busy} onChange={e=>setDate(e.target.value)}/></label><button className="btn primary" disabled={busy||imagesLoading||!!imageError||invoice.total<=0}>{busy?'承認中…':'承認して外注費に追加'}</button></div></form>}
 {approved&&<p className="ok">承認済み・経費一覧に追加済みです。</p>}
 </dialog>;
}

export default function InvoiceTasks({onApproved,staff}:{onApproved:()=>void;staff:Staff}){
 const [rows,setRows]=useState<Task[]>([]);const [filter,setFilter]=useState<'pending'|'approved'>('pending');const [selected,setSelected]=useState<Task|null>(null);
 const [error,setError]=useState('');const [message,setMessage]=useState('');const [loading,setLoading]=useState(true);const [revision,setRevision]=useState(0);
 useEffect(()=>{
  let active=true;let fetching=false;
  const refresh=async()=>{if(fetching)return;fetching=true;try{const data=await fetchTasks();if(active){setRows(data);setError('');}}catch(e){if(active)setError(messageOf(e));}finally{fetching=false;if(active)setLoading(false);}};
  void refresh();const timer=window.setInterval(()=>{if(document.visibilityState==='visible')void refresh();},30000);
  return()=>{active=false;window.clearInterval(timer);};
 },[revision]);
 const pending=rows.filter(row=>!approval(row.invoice)).length;
 const filtered=rows.filter(row=>filter==='pending'?!approval(row.invoice):!!approval(row.invoice));
 return <section className="card invoice-tasks" aria-label="タスク"><div className="toolbar"><h3>タスク</h3><span>書類承認待ち {pending}件</span><select aria-label="書類の状態" value={filter} onChange={e=>setFilter(e.target.value as 'pending'|'approved')}><option value="pending">承認待ち</option><option value="approved">承認済み</option></select></div>
 {error&&<div className="error" role="alert">{error}<button className="btn" onClick={()=>setRevision(n=>n+1)}>再読み込み</button></div>}{message&&<p className="ok" role="status">{message}</p>}
 {loading?<p>読み込み中…</p>:<ul className="invoice-task-rows">{filtered.map(row=><li key={row.id}><button onClick={()=>setSelected(row)}><span>{staffDisplayName(row.name)}<small>{row.month.slice(0,7)} {row.invoice?'請求書':''}{row.invoice&&row.receipts?'・':''}{row.receipts?'領収書':''}</small></span><strong>{row.invoice?yen(row.invoice.total):'領収書のみ'}</strong><span>確認 ›</span></button></li>)}<PhotoReviewTasks /><MalfunctionTasks staff={staff} /></ul>}
 {selected&&<InvoiceReview key={selected.id} task={selected} onClose={()=>setSelected(null)} onApproved={()=>{setSelected(null);setRevision(n=>n+1);setMessage('承認し、経費一覧の外注費に追加しました。');onApproved();}}/>}
 </section>;
}

export function AdminPackedSummary(){
 const [people,setPeople]=useState<Person[]>([]);const [staffId,setStaffId]=useState('');const [error,setError]=useState('');
 useEffect(()=>{let active=true;void(async()=>{
  const {data,error}=await getSupabase().from('staff').select('id,name').eq('is_active',true).order('name');if(error)throw error;
  if(active){const rows=data.map(p=>({staff_id:p.id,details:{issuer_name:p.name}}));setPeople(rows);setStaffId(rows[0]?.staff_id??'');}
 })().catch(e=>{if(active)setError(messageOf(e));});return()=>{active=false;};},[]);
 return <section className="card" style={{marginTop:16}}><h3>担当者別の納品実績</h3>{error&&<p className="error">{error}</p>}<label>担当者 <select value={staffId} onChange={e=>setStaffId(e.target.value)}>{people.map(p=><option key={p.staff_id} value={p.staff_id}>{staffDisplayName(p.details.issuer_name)}</option>)}</select></label>{staffId&&<PackedSummary staffId={staffId}/>}</section>;
}
