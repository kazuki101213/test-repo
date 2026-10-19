import {useRef,useState} from 'react';
import {deliveryWorkflowButtons,workflowButtonDirection} from '@bussan/shared';
import type {DeliveryTask,InventoryAction,ProductPanel,WorkflowButton} from '@bussan/shared';
import {performInventoryAction} from '../api';
import WorkflowConfirmation from './WorkflowConfirmation';

const panels=new Set(['photos','packingPhotos','description','messages','comments','listing','shipping']);
const isReversal=(button:WorkflowButton)=>button.key.endsWith('_cancel')||button.key==='resell';
export default function WorkflowControls({task,onChanged,onError,onPanel}:{task:DeliveryTask;onChanged:()=>Promise<void>;onError:(message:string|null)=>void;onPanel?:(panel:ProductPanel)=>void}){
 const [busy,setBusy]=useState(false),[form,setForm]=useState<WorkflowButton|null>(null),[note,setNote]=useState('');
 const [confirming,setConfirming]=useState<WorkflowButton|null>(null);
 const lock=useRef(false),request=useRef(crypto.randomUUID());
 const buttons=deliveryWorkflowButtons(task);
 const photoActions:Record<string,string[]>={
  'Amazon返送依頼':['return_request_complete'],
  '動作不良':['comments','report_cancel'],
  '出品中':['packingPhotos','listing_cancel'],
  '商品登録前':['photos','listing','listing_complete','inspection_cancel','yahoo_instruction_cancel'],
  '取引中':['shipping','messages','trade_cancel','resell'],
  '返品処理':['supplier_return_cancel'],
 };
 const besidePhoto=photoActions[task.status]??[];
 const renderButton=(button:WorkflowButton)=><button key={button.key} type="button" className="btn" data-action={button.key} data-direction={workflowButtonDirection(button.key)} data-wide={button.label.length > 7} disabled={busy||(['listing','listing_complete'].includes(button.key)&&task.photo_review_approved!==true)} title={['listing','listing_complete'].includes(button.key)&&task.photo_review_approved!==true?'管理アプリで商品写真の承認が必要です':undefined} onClick={()=>choose(button)}>{button.label}</button>;
 const photoButtons=buttons.filter(button=>besidePhoto.includes(button.key));
 const photoButtonContent=task.status==='取引中'?<>{photoButtons.some(button=>panels.has(button.key))&&<div className="workflow-photo-row workflow-photo-row-top">{photoButtons.filter(button=>panels.has(button.key)).map(renderButton)}</div>}<div className="workflow-photo-row workflow-photo-row-back">{photoButtons.filter(button=>!panels.has(button.key)).map(renderButton)}</div></>:photoButtons.map(renderButton);
 async function run(button:WorkflowButton,confirmed=false){
  if(lock.current)return;
  if(!confirmed&&button.confirmation&&!window.confirm(button.confirmation))return;
  lock.current=true;setBusy(true);onError(null);
  try{await performInventoryAction(task,button.key as InventoryAction,confirmed&&isReversal(button)&&button.note?(button.confirmation??`${button.label}を確認しました`):note,request.current);request.current=crypto.randomUUID();setForm(null);setNote('');await onChanged();}
  catch(cause){onError(cause instanceof Error?cause.message:String(cause));}
  finally{lock.current=false;setBusy(false);setConfirming(null);}
 }
 function choose(button:WorkflowButton){
  if(button.key==='listing_complete'){onPanel?.('listing');return;}
  if(panels.has(button.key)){onPanel?.(button.key as ProductPanel);return;}
  request.current=crypto.randomUUID();
  if(isReversal(button)){setForm(null);setNote('');setConfirming(button);return;}
  if(button.note){setForm(button);setNote('');}else setConfirming(button);
 }
 return <div className="workflow-controls" aria-label={`${task.sku}の操作`}>
  <div className="workflow-buttons">{photoButtons.length>0?<><div className="workflow-photo-buttons">{photoButtonContent}</div>{buttons.filter(button=>!besidePhoto.includes(button.key)).map(renderButton)}</>:buttons.map(renderButton)}</div>
  {form&&buttons.some(button=>button.key===form.key)&&<div className="workflow-action-form">
   <label>{form.key==='report'?form.label+'の内容':'理由'}<textarea value={note} maxLength={2000} disabled={busy} onChange={event=>setNote(event.target.value)} /></label>
   <button type="button" className="btn primary" disabled={busy||!note.trim()} onClick={()=>setConfirming(form)}>{busy?'更新中…':form.key==='report'?'仕入担当者に報告':'確定'}</button>
   <button type="button" className="btn ghost" disabled={busy} onClick={()=>{setForm(null);setNote('');}}>閉じる</button>
  </div>}
  {confirming&&<WorkflowConfirmation button={confirming} busy={busy} onConfirm={()=>void run(confirming,true)} onCancel={()=>setConfirming(null)}/>}
 </div>;
}
