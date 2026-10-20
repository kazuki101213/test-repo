import {useRef,useState} from 'react';
import {deliveryWorkflowButtons,workflowButtonDirection} from '@bussan/shared';
import type {DeliveryTask,InventoryAction,ProductPanel,WorkflowButton} from '@bussan/shared';
import {performInventoryAction,submitMalfunctionReport,performDatedInventoryAction,completeDeliveryWork,completeDeliveryCompensation} from '../api';
import type {ReportAttachment} from '../api';
import WorkflowConfirmation from './WorkflowConfirmation';
import WorkDateConfirmation from './WorkDateConfirmation';

const panels=new Set(['photos','packingPhotos','description','messages','comments','listing','shipping']);
const isReversal=(button:WorkflowButton)=>button.key.endsWith('_cancel')||button.key==='resell';
export default function WorkflowControls({task,onChanged,onError,onPanel}:{task:DeliveryTask;onChanged:()=>Promise<void>;onError:(message:string|null)=>void;onPanel?:(panel:ProductPanel)=>void}){
 const [busy,setBusy]=useState(false),[form,setForm]=useState<WorkflowButton|null>(null),[note,setNote]=useState('');
 const [confirming,setConfirming]=useState<WorkflowButton|null>(null);
 const [photos,setPhotos]=useState<ReportAttachment[]>([]);
 const photoInput=useRef<HTMLInputElement>(null);
 const lock=useRef(false),request=useRef(crypto.randomUUID());
 const buttons=deliveryWorkflowButtons(task);
 const photoActions:Record<string,string[]>={
  'Amazon返送依頼':['return_request_complete'],
  '動作不良':['comments','messages','supplier_return_complete','return_impossible','work_complete','report_cancel'],
  'Amazon補填申請中':['compensation_complete','work_complete'],
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
  try{
   if(button.key==='compensation_complete')await completeDeliveryCompensation(task.id,request.current);
   else if(button.key==='report'&&photos.length)await submitMalfunctionReport(task,note,request.current,photos);
   else await performInventoryAction(task,button.key as InventoryAction,confirmed&&isReversal(button)&&button.note?(button.confirmation??`${button.label}を確認しました`):note,request.current);
   request.current=crypto.randomUUID();setForm(null);setNote('');setPhotos([]);await onChanged();
  }
  catch(cause){onError(cause instanceof Error?cause.message:typeof cause==='object'&&cause&&'message' in cause&&typeof cause.message==='string'?cause.message:'状態を変更できませんでした。画面を再読み込みして確認してください。');}
  finally{lock.current=false;setBusy(false);setConfirming(null);}
 }
 function choose(button:WorkflowButton){
  if(button.key==='listing_complete'){onPanel?.('listing');return;}
  if(panels.has(button.key)){onPanel?.(button.key as ProductPanel);return;}
  request.current=crypto.randomUUID();
  setPhotos([]);
  if(isReversal(button)){setForm(null);setNote('');setConfirming(button);return;}
  if(button.note){setForm(button);setNote('');}else setConfirming(button);
 }
 return <div className="workflow-controls" aria-label={`${task.sku}の操作`}>
  <div className="workflow-buttons">{photoButtons.length>0?<><div className="workflow-photo-buttons">{photoButtonContent}</div>{buttons.filter(button=>!besidePhoto.includes(button.key)).map(renderButton)}</>:buttons.map(renderButton)}</div>
  {form&&buttons.some(button=>button.key===form.key)&&<div className="workflow-action-form">
   <label>{form.key==='report'?form.label+'の内容':'理由'}<textarea value={note} maxLength={2000} disabled={busy} onChange={event=>setNote(event.target.value)} /></label>
   <div className="workflow-report-actions">
   {form.key==='report'&&<><input ref={photoInput} type="file" accept="image/*" multiple hidden aria-label="報告写真を選択" disabled={busy} onChange={event=>{
    const selected=Array.from(event.target.files??[]);event.target.value='';
    if(photos.length+selected.length>10){onError('写真は一度に10枚まで追加できます。');return;}
    if(selected.some(file=>!file.type.startsWith('image/'))){onError('画像ファイルを選択してください。');return;}
    request.current=crypto.randomUUID();setPhotos(current=>[...current,...selected.map(file=>({id:'',file}))].map(photo=>({...photo,id:crypto.randomUUID()})));onError(null);
   }}/><button type="button" className="btn workflow-report-photo" aria-label={`写真を追加（${photos.length}枚）`} title="報告写真を追加" disabled={busy} onClick={()=>photoInput.current?.click()}><svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h4l2-3h6l2 3h4v15H3z"/><circle cx="12" cy="13" r="4"/></svg>{photos.length>0&&<span>{photos.length}</span>}</button></>}
   <button type="button" className="btn primary" disabled={busy||!note.trim()} onClick={()=>setConfirming(form)}>{busy?'更新中…':form.key==='report'?'仕入担当者に報告':'確定'}</button>
   </div>
   <button type="button" className="btn ghost" disabled={busy} onClick={()=>{setForm(null);setNote('');setPhotos([]);}}>閉じる</button>
   {form.key==='report'&&photos.length>0&&<ul className="workflow-report-photo-list">{photos.map((photo,index)=><li key={photo.id}>写真{index+1}：{photo.file.name}<button type="button" className="btn ghost" disabled={busy} aria-label={`写真${index+1}を外す`} onClick={()=>{request.current=crypto.randomUUID();setPhotos(current=>current.filter(entry=>entry.id!==photo.id).map(entry=>({...entry,id:crypto.randomUUID()})));}}>外す</button></li>)}</ul>}
  </div>}
  {confirming&&(['supplier_return_complete','work_complete'].includes(confirming.key)?<WorkDateConfirmation title={confirming.key==='work_complete'?'作業完了しますか。':'返品完了しますか。'} purchasedAt={task.purchased_at} savedDate={task.packed_on} onCancel={()=>setConfirming(null)} onConfirm={async date=>{if(confirming.key==='work_complete')await completeDeliveryWork(task.id,date);else await performDatedInventoryAction(task,'supplier_return_complete',date,request.current);request.current=crypto.randomUUID();await onChanged();}}/>:<WorkflowConfirmation button={confirming} busy={busy} onConfirm={()=>void run(confirming,true)} onCancel={()=>setConfirming(null)}/>)}
 </div>;
}
