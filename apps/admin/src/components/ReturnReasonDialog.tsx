import {useEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';

export default function ReturnReasonDialog({label,onSubmit,onCancel}:{label:string;onSubmit:(reason:string)=>Promise<void>;onCancel:()=>void}){
 const dialog=useRef<HTMLDialogElement>(null),lock=useRef(false);
 const [reason,setReason]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 useEffect(()=>{const element=dialog.current;if(element&&!element.open)element.showModal();return()=>element?.close();},[]);
 function cancel(){if(!lock.current)onCancel();}
 async function submit(){
  if(lock.current||!reason.trim())return;
  lock.current=true;setBusy(true);setError('');
  try{await onSubmit(reason.trim());}
  catch(cause){setError(cause instanceof Error?cause.message:(cause as {message?:string})?.message||'差し戻しに失敗しました。');}
  finally{lock.current=false;setBusy(false);}
 }
 return createPortal(<dialog ref={dialog} className="admin-task-confirmation" aria-label="差し戻しの確認"
  onCancel={event=>{event.preventDefault();cancel();}}>
  <h3>実行しますか</h3><p>{label}</p>
  <form onSubmit={event=>{event.preventDefault();void submit();}}>
   <label className="field">差し戻し理由<textarea aria-label="差し戻し理由" required maxLength={2000} value={reason} disabled={busy} onChange={event=>setReason(event.target.value)}/></label>
   <p>納品アプリのやることと通知で担当者にお知らせします。</p>
   {error&&<p className="error" role="alert">{error}</p>}
   <div className="admin-task-confirmation-actions">
    <button type="submit" className="btn primary" disabled={busy||!reason.trim()}>{busy?'実行中…':'はい'}</button>
    <button type="button" className="btn" disabled={busy} onClick={cancel}>キャンセル</button>
   </div>
  </form>
 </dialog>,document.body);
}
