import {useRef,useState} from 'react';
import {deliveryWorkflowButtons} from '@bussan/shared';
import type {DeliveryTask,InventoryAction,ProductPanel,WorkflowButton} from '@bussan/shared';
import {performInventoryAction} from '../api';

const panels=new Set(['photos','packingPhotos','description','messages','comments','listing','shipping']);
export default function WorkflowControls({task,onChanged,onError,onPanel}:{task:DeliveryTask;onChanged:()=>Promise<void>;onError:(message:string|null)=>void;onPanel?:(panel:ProductPanel)=>void}){
 const [busy,setBusy]=useState(false),[form,setForm]=useState<WorkflowButton|null>(null),[note,setNote]=useState('');
 const lock=useRef(false),request=useRef(crypto.randomUUID());
 const buttons=deliveryWorkflowButtons(task);
 async function run(button:WorkflowButton){
  if(lock.current)return;
  if(button.confirmation&&!window.confirm(button.confirmation))return;
  lock.current=true;setBusy(true);onError(null);
  try{await performInventoryAction(task,button.key as InventoryAction,note,request.current);request.current=crypto.randomUUID();setForm(null);setNote('');await onChanged();}
  catch(cause){onError(cause instanceof Error?cause.message:String(cause));}
  finally{lock.current=false;setBusy(false);}
 }
 function choose(button:WorkflowButton){
  if(panels.has(button.key)){onPanel?.(button.key as ProductPanel);return;}
  request.current=crypto.randomUUID();
  if(button.note){setForm(button);setNote('');}else void run(button);
 }
 return <div className="workflow-controls" aria-label={`${task.sku}の操作`}>
  <div className="workflow-buttons">{buttons.map(button=><button key={button.key} type="button" className="btn" data-action={button.key} data-wide={button.label.length > 7} disabled={busy} onClick={()=>choose(button)}>{button.label}</button>)}</div>
  {form&&buttons.some(button=>button.key===form.key)&&<div className="workflow-action-form">
   <label>{form.key==='report'?form.label+'の内容':'理由'}<textarea value={note} maxLength={2000} disabled={busy} onChange={event=>setNote(event.target.value)} /></label>
   <button type="button" className="btn primary" disabled={busy||!note.trim()} onClick={()=>void run(form)}>{busy?'更新中…':form.key==='report'?'仕入担当者に報告':'確定'}</button>
   <button type="button" className="btn ghost" disabled={busy} onClick={()=>{setForm(null);setNote('');}}>閉じる</button>
  </div>}
 </div>;
}
