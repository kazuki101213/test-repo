import {useEffect,useRef,useState} from 'react';
import {fetchAccessoryUsage,reassignAccessoryUsage,type AccessoryUsageContext} from '@bussan/shared';

export default function AccessoryUsageDialog({itemId,onClose,onSaved}:{itemId:string;onClose:()=>void;onSaved:(serial:string)=>Promise<void>}){
 const dialog=useRef<HTMLDialogElement>(null),locked=useRef(false);
 const [context,setContext]=useState<AccessoryUsageContext|null>(null),[serial,setSerial]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 useEffect(()=>{let live=true;if(!dialog.current?.open)dialog.current?.showModal();void fetchAccessoryUsage(itemId).then(value=>{if(live){setContext(value);setSerial(value.serial);}}).catch(cause=>{if(live)setError(cause?.message||'利用記録を読み込めませんでした');});return()=>{live=false;};},[itemId]);
 async function save(){
  if(locked.current||!context)return;locked.current=true;setBusy(true);setError('');
  try{const result=await reassignAccessoryUsage(itemId,serial,context.revision);await onSaved(result.serial);}
  catch(cause){setError((cause as {message?:string})?.message||'利用記録を変更できませんでした');}
  finally{locked.current=false;setBusy(false);}
 }
 return <dialog ref={dialog} className="card" style={{width:'min(420px,calc(100vw - 32px))'}} aria-label="利用記録を変更" onCancel={event=>{event.preventDefault();if(!locked.current)onClose();}}>
  <form onSubmit={event=>{event.preventDefault();void save();}}>
   <h3>利用記録を変更</h3>{context&&<p>{context.sku}<br/>現在の利用記録：{context.serial}</p>}
   <label>使用先の通番号<input autoFocus required maxLength={32} placeholder="例：2448" value={serial} disabled={!context||busy} onChange={event=>setSerial(event.target.value)}/></label>
   <p>付属品を指定した本体へ付け替えます。</p>{error&&<p role="alert" className="error">{error}</p>}
   <div className="toolbar"><button className="btn primary" disabled={!context||busy||!serial.trim()||serial.trim().toLowerCase()===context.serial}>{busy?'保存中…':'保存'}</button><button type="button" className="btn" disabled={busy} onClick={onClose}>閉じる</button></div>
  </form>
 </dialog>;
}
