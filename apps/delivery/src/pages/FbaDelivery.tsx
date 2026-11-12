import {useEffect,useRef,useState} from 'react';
import {canViewDeliveryAssignee} from '@bussan/shared';
import type {DeliveryTask,Staff} from '@bussan/shared';
import {fetchTask} from '../api';
import {canSelectFbaItem,fbaSelectionAccount} from '../fbaSelection';
import {deliveryErrorMessage} from '../errors';
import FbaInboundPlan from './FbaInboundPlan';
import {inboundRequest,type InboundPlan} from './fbaInboundApi';
import './fbaDelivery.css';

function groupSelection(rows:DeliveryTask[]) {
 return (['FBA1','FBA2'] as const).flatMap(account=>{
  const byAssignee=new Map<string,DeliveryTask[]>();
  for(const item of rows.filter(item=>fbaSelectionAccount(item)===account)){
   const assignee=item.deliverer_id??'';
   const items=byAssignee.get(assignee)??[];
   items.push(item);
   byAssignee.set(assignee,items);
  }
  return [...byAssignee].map(([assignee,items])=>({account,assignee,items}));
 });
}

export default function FbaDelivery({staff,itemIds,createSelectedDrafts,onSelectionChange}:{
 staff:Staff;itemIds:string[];createSelectedDrafts:boolean;onSelectionChange:(ids:string[])=>void;
}) {
 const [loading,setLoading]=useState(false),[error,setError]=useState('');
 const [plans,setPlans]=useState<InboundPlan[]>([]),[openId,setOpenId]=useState(''),[historyError,setHistoryError]=useState(''),[creating,setCreating]=useState(false);
 const [historyReload,setHistoryReload]=useState(0),[historyLoading,setHistoryLoading]=useState(true);
 const [draftError,setDraftError]=useState(''),[draftAttempt,setDraftAttempt]=useState(0);
 const [receivedNotice,setReceivedNotice]=useState(false);
 const attempted=useRef(-1);
 const listedPlans=useRef<InboundPlan[]>([]);
 useEffect(()=>{
  let active=true;
  setHistoryLoading(true);
  void Promise.resolve().then(()=>inboundRequest<{plans:InboundPlan[]}>('list')).then(result=>{
   if(active){
    listedPlans.current=result.plans;setPlans(result.plans);setHistoryError('');
    setOpenId(current=>result.plans.some(plan=>plan.id===current)?current:'');
   }
  }).catch(cause=>{if(active){listedPlans.current=[];setHistoryError(deliveryErrorMessage(cause));}})
    .finally(()=>{if(active)setHistoryLoading(false);});
  return()=>{active=false;};
 },[staff.id,historyReload]);
 const open=plans.find(p=>p.id===openId);
 function updatePlan(next:InboundPlan){
  if(next.stage==='cancelled'||next.received_at){
   setPlans(current=>current.filter(plan=>plan.id!==next.id));
   setOpenId(current=>current===next.id?'':current);
   if(next.received_at)setReceivedNotice(true);
   return;
  }
  setPlans(current=>current.some(p=>p.id===next.id)?
   current.map(p=>p.id===next.id&&p.revision<=next.revision?next:p):[next,...current]);
 }
 const selectionKey=JSON.stringify(itemIds);
 const waitingToCreate=createSelectedDrafts&&historyLoading;
 useEffect(()=>{
  let active=true;const ids:string[]=JSON.parse(selectionKey);
  setError('');setLoading(createSelectedDrafts&&!!ids.length);
  if(!createSelectedDrafts||!ids.length||waitingToCreate)return()=>{active=false;};
  void Promise.allSettled(ids.map(id=>fetchTask(id,canViewDeliveryAssignee(staff)))).then(async results=>{
   if(!active)return;
   const available=results.flatMap(result=>result.status==='fulfilled'&&result.value&&canSelectFbaItem(result.value,staff)?[result.value]:[]);
   setLoading(false);
   if(available.length!==ids.length||available.some(item=>!item.deliverer_id)){
    setError('状態または担当者を確認し、在庫で商品を選び直してください。');
    return;
   }
   if(attempted.current===draftAttempt)return;
   attempted.current=draftAttempt;
   setCreating(true);setDraftError('');
   const saved=new Set<string>();
   let firstId='';
   try{
    for(const {items} of groupSelection(available)){
     const groupIds=items.map(item=>item.id);
     const existing=listedPlans.current.find(plan=>plan.stage==='draft'&&plan.fba_inbound_items.length===groupIds.length&&
      plan.fba_inbound_items.every(item=>groupIds.includes(item.item_id)));
     const plan=existing??(await inboundRequest<{plan:InboundPlan}>('new',{items:groupIds})).plan;
     if(!active)return;
     updatePlan(plan);
     if(!firstId)firstId=plan.id;
     for(const id of groupIds)saved.add(id);
    }
   }catch(cause){
    if(active){
     setDraftError(deliveryErrorMessage(cause));
     setHistoryReload(value=>value+1);
    }
   }finally{
    if(active){
     if(firstId)setOpenId(firstId);
     setCreating(false);
     if(saved.size)onSelectionChange(ids.filter(id=>!saved.has(id)));
    }
   }
  }).catch(cause=>{if(active){setLoading(false);setError(deliveryErrorMessage(cause));}});
  return()=>{active=false;};
 },[selectionKey,staff.id,staff.role,createSelectedDrafts,waitingToCreate,draftAttempt,onSelectionChange]);

 return <section className="fba-delivery" aria-labelledby="fba-delivery-heading">
  <h2 id="fba-delivery-heading">FBA納品</h2>
  <div className="fba-history">
   <label><span>納品履歴</span> <select value={openId} disabled={creating} onChange={e=>{setOpenId(e.target.value);setReceivedNotice(false);}}>
    <option value="">納品を選択</option>
    {plans.map(p=><option key={p.id} value={p.id}>{p.account}/{p.name}/{p.fba_inbound_items.length}点</option>)}
   </select></label>
   <button type="button" className="btn" disabled={creating||loading} onClick={()=>setHistoryReload(value=>value+1)}>履歴更新</button>
  </div>
  {receivedNotice&&<p role="status">すべての商品の受領を確認しました。</p>}
  {historyError&&<p className="error" role="alert">{historyError}</p>}
  {open&&<FbaInboundPlan key={open.id} plan={open} onUpdate={updatePlan}/>}
  {loading&&<p role="status">選択商品を確認中…</p>}
  {creating&&<p role="status">納品の下書きを準備中…</p>}
  {error&&<p className="error" role="alert">{error}</p>}
  {draftError&&<div className="fba-draft-error">
   <p className="error" role="alert">{draftError}</p>
   <button type="button" className="btn" disabled={loading||creating||historyLoading||!itemIds.length} onClick={()=>setDraftAttempt(value=>value+1)}>再試行</button>
  </div>}
  {!loading&&!creating&&(!createSelectedDrafts||!itemIds.length)&&!open&&!receivedNotice&&<p className="empty">在庫で納品する商品にチェックを入れてください。</p>}
 </section>;
}
