import {useRef,useState} from 'react';
import DateInput from './DateInput';
import WorkflowConfirmation from './WorkflowConfirmation';
const todayInJapan=()=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
export default function WorkDateConfirmation({title,purchasedAt,savedDate,onConfirm,onCancel}:{title:string;purchasedAt:string|null;savedDate?:string|null;onConfirm:(date:string)=>Promise<void>;onCancel:()=>void}){
 const [date,setDate]=useState(()=>savedDate||todayInJapan()),[busy,setBusy]=useState(false),[error,setError]=useState('');const lock=useRef(false);
 const today=todayInJapan();
 const valid=/^\d{4}-\d{2}-\d{2}$/.test(date)&&!Number.isNaN(Date.parse(date))&&new Date(date+'T00:00:00Z').toISOString().slice(0,10)===date&&date<=today&&(!purchasedAt||date>=purchasedAt.slice(0,10));
 async function save(){if(lock.current||!valid)return;lock.current=true;setBusy(true);setError('');try{await onConfirm(date);onCancel();}catch(cause){setError(cause instanceof Error?cause.message:typeof cause==='object'&&cause&&'message' in cause?String(cause.message):'登録できませんでした。一覧を再読み込みして確認してください。');}finally{lock.current=false;setBusy(false);}}
 return <WorkflowConfirmation title={title} button={{key:'work_complete',label:''}} busy={busy} confirmDisabled={!valid} onConfirm={()=>void save()} onCancel={onCancel}>
  <label className="work-date-field">作業完了日<DateInput aria-label="作業完了日" value={date} min={purchasedAt?.slice(0,10)} max={today} disabled={busy||!!savedDate} style={{width:'9em',maxWidth:'100%'}} onChange={event=>setDate(event.target.value)}/></label>
  {error&&<p className="error" role="alert">{error}</p>}
 </WorkflowConfirmation>;
}
