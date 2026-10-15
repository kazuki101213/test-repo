import {useState} from 'react';
import {STATUSES} from '@bussan/shared';
import type {DeliveryTask,ItemStatus} from '@bussan/shared';
import {setInventoryWorkflow} from '../api';

export default function WorkflowControls({task,onChanged,onError}:{task:DeliveryTask;onChanged:()=>Promise<void>;onError:(message:string|null)=>void}){
 const [busy,setBusy]=useState(false);
 if((task.is_accessory && !task.sku.split('-')[0].toLowerCase().endsWith('c')) || task.status==='販売済')return null;
 async function transition(status:ItemStatus){
  if(busy)return;
  if(status==='販売済'&&!window.confirm('販売金額・振込金額を0円、販売日を本日として販売済にします。'))return;
  setBusy(true);onError(null);
  try{await setInventoryWorkflow(task.id,status);await onChanged();}
  catch(cause){onError(cause instanceof Error?cause.message:String(cause));}
  finally{setBusy(false);}
 }
 return <div className="workflow-controls">
  <select aria-label="販売状態" value={task.status} disabled={busy} onChange={event=>void transition(event.target.value as ItemStatus)}>
   {STATUSES.filter(status=>status!=='販売済').map(status=><option key={status} value={status}>{status}</option>)}
  </select>
  {task.status==='Amazon返送依頼'&&<button type="button" className="btn" disabled={busy} onClick={()=>void transition('検品中')}>返送依頼済みにする</button>}
  {task.status!=='返品処理'&&<button type="button" className="btn" disabled={busy} onClick={()=>void transition('販売済')}>0円で販売済にする</button>}
 </div>;
}
