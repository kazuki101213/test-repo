import {createClient} from 'npm:@supabase/supabase-js@2.45.4';
import {AmazonAccountError} from '../_shared/amazonAccounts.ts';
import {AmazonError,amazonClient,amazonPdfUrl,amazonProblem,charge,charges,enc,inbound,marketplace,planPath,type Amazon} from './amazon.ts';
import {canPublish,canResizeBoxes,expired,invalid,needsWindow,senders,transportSelection,unknownPrecondition,uuid,validateBoxes,WorkflowError,
 type Box,type Item,type Owner,type Pending,type Plan,type Shipment,type Stage,type Work} from './workflow.ts';

const headers={
 'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type',
 'Access-Control-Allow-Methods':'POST, OPTIONS','Cache-Control':'no-store','Content-Type':'application/json',
};
const reply=(status:number,data:unknown)=>new Response(JSON.stringify(data),{status,headers});
const select='id,account,staff_id,name,stage,revision,amazon_id,pending,work,created_at,fba_inbound_items(item_id,sku,asin,title,condition,sales_channel,published_at)';
const planSelect=(plan:Plan)=>({...plan,sender:senders[plan.account]});
const lookup=(item:Item)=>({msku:item.sku,quantity:1});
const shipmentPath=(plan:Plan,id:string)=>planPath(plan.amazon_id!)+'/shipments/'+enc(id);
const shipped=['SHIPPED','IN_TRANSIT','DELIVERED','CHECKED_IN','RECEIVING','CLOSED'];
const canCheckReceived=['DELIVERED','CHECKED_IN','RECEIVING','CLOSED'];
const smallParcel=['GROUND_SMALL_PARCEL','AIR_SMALL_PARCEL','AIR_SMALL_PARCEL_EXPRESS'];
const validSolutions=['AMAZON_PARTNERED_CARRIER','USE_YOUR_OWN_CARRIER'];
// Amazon caps these three option lists at 20 entries per page.
const optionPageSize={pageSize:'20'};
const listPacking=(api:Amazon,path:string)=>api.pages(path+'/packingOptions','packingOptions',optionPageSize);
const availablePacking=async(api:Amazon,path:string)=>(await listPacking(api,path))
 .filter(row=>row.status==='OFFERED'&&(!row.expiration||Date.parse(row.expiration)>Date.now()));
const localDate=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const stageAfter:Record<string,Stage>={create:'created',packing:'packing-options',choosePacking:'packing-confirmed',boxes:'packed',resizeBoxes:'packed',
 placements:'placement-options',transport:'transport-options',confirmPlacement:'placement-confirmed',confirmTransport:'ready'};

function dateWindow(value:unknown) {
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||value<localDate()) return invalid('発送予定日は今日以降の日付を指定してください。');
 const at=new Date(value+'T09:00:00+09:00');
 if(!Number.isFinite(+at)||at.toISOString().slice(0,10)!==value) return invalid('発送予定日を確認してください。');
 return at.toISOString();
}
function lineItem(item:Item,owners:Work['owners']) {
 const owner=owners?.[item.item_id];
 if(!owner) return invalid('梱包・ラベル情報を確認できません。');
 return {...lookup(item),...owner};
}
async function packingGroups(api:Amazon,path:string,groups:string[],items:Item[]) {
 const bySku=new Map(items.map(i=>[i.sku,i]));
 const result:Record<string,string>={};
 for(const group of groups){
  for(const remote of await api.pages(path+'/packingGroups/'+enc(group)+'/items','items')){
   const local=bySku.get(remote.msku);
   if(!local||local.asin!==remote.asin||remote.quantity!==1||result[local.item_id]) return invalid('Amazonの梱包グループと納品商品が一致しません。');
   result[local.item_id]=group;
  }
 }
 if(Object.keys(result).length!==items.length) return invalid('Amazonの梱包グループで一部の商品を確認できません。');
 return result;
}
function groupedBoxes(boxes:Box[],plan:Plan) {
 const items=new Map(plan.fba_inbound_items.map(item=>[item.item_id,item]));
 const byGroup=new Map<string,unknown[]>();
 for(const box of boxes){
  const group=plan.work.groups![box.items[0]];
  const rows=byGroup.get(group)??[];
  rows.push({contentInformationSource:'BOX_CONTENT_PROVIDED',dimensions:{length:box.length,width:box.width,height:box.height,unitOfMeasurement:'CM'},
   weight:{value:box.weight,unit:'KG'},quantity:1,items:box.items.map(id=>lineItem(items.get(id)!,plan.work.owners))});
  byGroup.set(group,rows);
 }
 return {packageGroupings:[...byGroup.entries()].map(([packingGroupId,boxes])=>({packingGroupId,boxes}))};
}
async function prep(api:Amazon,items:Item[]) {
 const found=new Map<string,any>();
 for(let offset=0;offset<items.length;offset+=40){
  const chunk=items.slice(offset,offset+40);
  // In Japan, repeated mskus query parameters only return the first SKU.
  const result=await api.call(inbound+'/items/prepDetails',{marketplaceId:marketplace,mskus:chunk.map(i=>i.sku).join(',')});
  if(!Array.isArray(result.mskuPrepDetails))throw new WorkflowError(502,'Amazonの梱包条件を確認できませんでした。');
  for(const row of result.mskuPrepDetails)found.set(row.msku,row);
 }
 const owners:Record<string,Owner>={};
 const requirements:Record<string,string[]>={};
 const unset:string[]=[];
 let reviewRequired=false;
 for(const item of items){
  const detail=found.get(item.sku);
  if(!detail||!detail.prepCategory||detail.prepCategory==='UNKNOWN'){unset.push(item.sku);continue;}
  if(detail.prepOwnerConstraint==='AMAZON_ONLY'||detail.labelOwnerConstraint==='AMAZON_ONLY') return invalid(item.sku+'：Amazon指定の梱包・ラベル貼付条件を確認してください。');
  const types:string[]=detail.prepTypes??[];
  const labelOnly=detail.prepCategory==='NONE'&&types.includes('ITEM_LABELING')&&types.every(type=>['ITEM_LABELING','ITEM_NO_PREP','NONE'].includes(type));
  const labelOwner=detail.labelOwnerConstraint==='NONE_ONLY'?'NONE':'SELLER';
  // Amazon Japan requires a prep owner when the seller applies the label, even with no physical prep.
  const sellerPrep=detail.prepOwnerConstraint==='SELLER_ONLY'||detail.prepCategory!=='NONE'||(labelOnly&&labelOwner==='SELLER');
  const prepOwner=detail.prepOwnerConstraint!=='NONE_ONLY'&&sellerPrep?'SELLER':'NONE';
  owners[item.item_id]={prepOwner,labelOwner};
  reviewRequired||=(prepOwner==='SELLER'&&!labelOnly)||labelOwner!=='SELLER';
  if(detail.allOwnersConstraint==='MUST_MATCH'&&owners[item.item_id].prepOwner!==owners[item.item_id].labelOwner) return invalid(item.sku+'：梱包とラベルの担当をAmazonの指定どおりに設定してください。');
  requirements[item.item_id]=[detail.prepCategory,...types];
 }
 return {owners,requirements,unset,reviewRequired};
}
type PrepDetails=Awaited<ReturnType<typeof prep>>;
async function getShipments(api:Amazon,plan:Plan,withBoxes:boolean,ids=plan.work.placement?.shipmentIds??[]):Promise<Shipment[]> {
 const result:Shipment[]=[];
 for(const id of ids) {
  const row=await api.call(shipmentPath(plan,id));
  if(row.shipmentId!==id||row.placementOptionId!==plan.work.placement?.id) throw new WorkflowError(502,'Amazonの納品先の応答が一致しません。');
  const previous=plan.work.shipments?.find(s=>s.id===id);
  const shipment:Shipment={...previous,id,confirmationId:row.shipmentConfirmationId,warehouse:row.destination?.warehouseId||
   [row.destination?.address?.stateOrProvinceCode,row.destination?.address?.city].filter(Boolean).join(' '),status:row.status??'UNCONFIRMED'};
  if(withBoxes&&shipment.confirmationId){
   const boxes=await api.pages(shipmentPath(plan,id)+'/boxes','boxes');
   const tracking=new Map<string,string>((row.trackingDetails?.spdTrackingDetail?.spdTrackingItems??[]).flatMap((t:any)=>typeof t.boxId==='string'&&typeof t.trackingId==='string'?[[t.boxId,t.trackingId]]:[]));
   shipment.boxes=boxes.filter(box=>typeof box.boxId==='string').map(box=>({id:box.boxId,skus:(box.items??[]).map((i:any)=>i.msku),
    tracking:tracking.get(box.boxId)??previous?.boxes?.find(b=>b.id===box.boxId)?.tracking}));
  }
  result.push(shipment);
 }
 return result;
}
async function checkPublished(api:Amazon,plan:Plan,shipments:Shipment[]) {
 const ids:string[]=[];
 const itemBySku=new Map(plan.fba_inbound_items.map(i=>[i.sku,i]));
 for(const shipment of shipments){
  if(!shipment.confirmationId||!canCheckReceived.includes(shipment.status))continue;
  const received:Record<string,number>={};
  {
   const response=await api.call('/fba/inbound/v0/shipments/'+enc(shipment.confirmationId)+'/items',
    {});
   if(!Array.isArray(response.payload?.ItemData)) throw new WorkflowError(502,'Amazonの受領数を確認できません。');
   for(const row of response.payload.ItemData) {
    if((row.ShipmentId&&row.ShipmentId!==shipment.confirmationId)||!itemBySku.has(row.SellerSKU)||!Number.isInteger(row.QuantityReceived))continue;
    received[row.SellerSKU]=row.QuantityReceived;
   }
   if(response.payload.NextToken)throw new WorkflowError(502,'Amazonから受領数の一部のみ返されました。');
  }
  shipment.received=received;
 }
 const candidates=plan.fba_inbound_items.filter(item=>!item.published_at&&shipments.some(s=>(s.received?.[item.sku]??0)>0));
 for(let offset=0;offset<candidates.length;offset+=20){
  const chunk=candidates.slice(offset,offset+20);
  const inventory=await api.call('/fba/inventory/v1/summaries',{granularityType:'Marketplace',granularityId:marketplace,
   marketplaceIds:marketplace,sellerSkus:chunk.map(item=>item.sku).join(','),details:'true'});
  const rows=inventory.payload?.inventorySummaries;
  if(!Array.isArray(rows))throw new WorkflowError(502,'Amazonの販売可能数を確認できません。');
  for(const item of chunk){
   const quantity=rows.find((row:any)=>row.sellerSku===item.sku&&row.asin===item.asin)?.inventoryDetails?.fulfillableQuantity;
   if(typeof quantity!=='number'||quantity<=0)continue;
   const listing=await api.call('/listings/2021-08-01/items/'+enc(api.sellerId)+'/'+enc(item.sku),
    {marketplaceIds:marketplace,includedData:'summaries'}).catch(error=>{
     if(error instanceof AmazonError&&error.remoteStatus===404)return null;
     throw error;
    });
   if(canPublish(listing,item,quantity,marketplace))ids.push(item.item_id);
   if(ids.length>=10)return ids;
  }
 }
 return ids;
}
function packingResult(work:Work,pending:Pending):Work {
 if(pending.action!=='resizeBoxes')return {...work,notice:undefined};
 if(!pending.boxes)throw new WorkflowError(409,'変更した箱情報を確認できません。');
 return {...work,boxes:pending.boxes,placements:undefined,placement:undefined,transport:undefined,
  selections:undefined,windows:undefined,selectedWindows:undefined,shipments:undefined,notice:undefined};
}
function eligiblePhase(plan:Plan,...stages:Stage[]){
 if(!stages.includes(plan.stage)) throw new WorkflowError(409,'納品の進行状況が変わりました。画面を更新してください。');
}

export async function handler(req:Request):Promise<Response>{
 if(req.method==='OPTIONS')return new Response(null,{status:204,headers});
 if(req.method!=='POST')return reply(405,{error:'POSTのみ利用できます。'});
 try{
  const url=Deno.env.get('SUPABASE_URL')!;
  const options={auth:{persistSession:false,autoRefreshToken:false},db:{schema:'app'}};
  const db=createClient(url,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,options);
  if(req.headers.has('x-delivery-dispatch')){
   const {data,error}=await db.rpc('delivery_push_config');
   const dispatch=req.headers.get('x-delivery-dispatch');
   if(error||!dispatch||dispatch!==data?.delivery_push_dispatch_token)throw new WorkflowError(401,'内部認証が必要です。');
   const input=await req.json().catch(()=>null);
   if(input?.action!=='connection'||!['FBA1','FBA2'].includes(input.account))return reply(400,{error:'操作を確認できません。'});
   const api=await amazonClient(input.account);
   if(input.compareListing===true){
    const inspect=async(path:string,query:Record<string,string>,field:string)=>{
     try{
      const result=await api.call(path,query);
      return {status:200,valid:Array.isArray(result[field])};
     }catch(error){
      if(!(error instanceof AmazonError))throw error;
      return {status:error.remoteStatus,code:error.code,requestId:error.requestId};
     }
    };
    const [inboundResult,listingResult]=await Promise.all([
     inspect(inbound+'/inboundPlans',{pageSize:'1'},'inboundPlans'),
     inspect('/listings/2021-08-01/items/'+enc(api.sellerId),{marketplaceIds:marketplace,pageSize:'1'},'items'),
    ]);
    return reply(200,{account:input.account,inbound:inboundResult,listing:listingResult});
   }
   const probe=await api.call(inbound+'/inboundPlans',{pageSize:'1'});
   if(!Array.isArray(probe.inboundPlans))throw new WorkflowError(502,'納品APIの応答を確認できません。');
   return reply(200,{connected:true,account:input.account});
  }
  const authorization=req.headers.get('authorization')??'';
  const token=/^Bearer\s+(\S+)$/i.exec(authorization)?.[1];
  if(!token)throw new WorkflowError(401,'ログインが必要です。');
  const client=createClient(url,Deno.env.get('SUPABASE_ANON_KEY')!,{...options,global:{headers:{Authorization:authorization}}});
  const user=await client.auth.getUser(token);
  if(user.error||!user.data.user)throw new WorkflowError(401,'再ログインしてください。');
  const staffId=await client.rpc('current_staff_id');
  if(staffId.error||!staffId.data)throw new WorkflowError(403,'利用権限を確認できません。');
  const staff=await db.from('staff').select('id,is_active,role').eq('id',staffId.data).maybeSingle();
  if(staff.error||!staff.data?.is_active)throw new WorkflowError(403,'利用権限を確認できません。');
  const admin=staff.data.role==='admin';
  const input=await req.json().catch(()=>null);
  if(!input||typeof input.action!=='string')return reply(400,{error:'操作を確認できません。'});
  const action=input.action as string;
  const read=async(id:string):Promise<Plan>=>{
   const response=await db.from('fba_inbound_plans').select(select).eq('id',id).maybeSingle();
   if(response.error||!response.data||(!admin&&response.data.staff_id!==staffId.data))throw new WorkflowError(404,'納品を確認できません。');
   return response.data as Plan;
  };
  if(action==='list'){
   let query=db.from('fba_inbound_plans').select(select).neq('stage','cancelled').order('created_at',{ascending:false}).limit(60);
   if(!admin)query=query.eq('staff_id',staffId.data);
   const response=await query;
   if(response.error)throw new WorkflowError(502,'納品履歴を取得できません。');
   return reply(200,{plans:(response.data as Plan[]).map(planSelect)});
  }
  if(action==='new'){
   if(!Array.isArray(input.items)||input.items.length<1||input.items.length>100||!input.items.every(uuid)) return invalid('在庫から納品商品を選んでください。');
   const response=await db.rpc('create_fba_inbound_draft',{p_user:user.data.user.id,p_items:input.items});
   if(response.error)throw new WorkflowError(response.error.code==='23505'?409:422,response.error.code?.match(/^(23505|22023|42501)$/)?response.error.message:'納品の下書きを保存できません。');
   return reply(200,{plan:planSelect(await read(response.data))});
  }
  if(!uuid(input.id))return invalid('納品を選んでください。');
  let plan=await read(input.id);
  const result=()=>reply(200,{plan:planSelect(plan)});
  if(action==='get')return result();
  if(!['poll','label'].includes(action)&&plan.revision!==input.revision)throw new WorkflowError(409,'納品の進行状況が変わりました。画面を更新してください。');
  const patch=async(data:Partial<Pick<Plan,'stage'|'work'|'pending'|'amazon_id'>>)=>{
   const response=await db.from('fba_inbound_plans').update({...data,revision:plan.revision+1,updated_at:new Date().toISOString()})
    .eq('id',plan.id).eq('revision',plan.revision).select(select).maybeSingle();
   if(response.error||!response.data)throw new WorkflowError(409,'別の画面で納品が更新されました。画面を更新してください。');
   plan=response.data as Plan;
  };
  const cancel=async()=>{
   const response=await db.rpc('cancel_fba_inbound_plan',{p_plan:plan.id,p_revision:plan.revision});
   if(response.error||!response.data)throw new WorkflowError(409,'取消状況を再確認してください。');
   plan=await read(plan.id);
  };
  if(action==='saveBoxes'){
   eligiblePhase(plan,'draft','created','packing-options','packing-confirmed');
   if(plan.pending)throw new WorkflowError(409,'Amazonの処理結果を先に確認してください。');
   await patch({work:{...plan.work,boxes:validateBoxes(input.boxes,plan.fba_inbound_items,plan.work.groups),notice:undefined}});
   return result();
  }
  if(action==='cancel'&&plan.stage==='draft'&&!plan.pending){await cancel();return result();}
  if(action==='poll'&&!plan.pending)return result();
  if(plan.pending&&!['poll','recover'].includes(action))throw new WorkflowError(409,'Amazonの処理結果を先に確認してください。');
  const api=await amazonClient(plan.account);
  const path=plan.amazon_id?planPath(plan.amazon_id):'';
  const items=plan.fba_inbound_items;
  async function start(work:Work,remote:string,method='POST',body?:unknown,details:Partial<Pending>={}){
   const pending:Pending={action,at:new Date().toISOString(),...details};
   const submitted={...work,notice:undefined};
   // Keep the box edits on a definite rejection so they can be corrected or retried.
   const rejectedWork=pending.action==='boxes'?submitted:plan.work;
   await patch({pending,work:submitted});
   let response;
   try {response=await api.call(remote,{},method,body);}
   catch(error){
    if(error instanceof AmazonError&&[400,401,403,404,422,429].includes(error.remoteStatus))await patch({pending:null,work:rejectedWork});
    throw error;
   }
   if(typeof response.operationId!=='string'||(pending.action==='create'&&typeof response.inboundPlanId!=='string'))throw new WorkflowError(502,'Amazonの受付結果を確認できません。重複防止のため納品履歴を照合してください。');
   await patch({pending:{...pending,op:response.operationId},...(pending.action==='create'?{amazon_id:response.inboundPlanId}:{})});
  }
  async function createDetails(){
   eligiblePhase(plan,'draft');validateBoxes(plan.work.boxes,items);
   const current=await db.from('items').select('id,sku,asin,condition,status,deliverer_id,sales_channel').in('id',items.map(i=>i.item_id));
   if(current.error)throw new WorkflowError(502,'納品商品の最新情報を取得できませんでした。');
   if(!items.every(i=>current.data?.some(x=>x.id===i.item_id&&x.sku===i.sku&&x.asin===i.asin&&x.condition===i.condition&&
     x.status==='商品登録前'&&x.deliverer_id===plan.staff_id&&(x.sales_channel===plan.account||(x.sales_channel==='FBA'&&plan.account==='FBA1')))))
    return invalid('商品の情報が変更されました。下書きを取り消し、在庫で選び直してください。');
   return prep(api,items);
  }
  function setupPrep(unset:string[],createAfterPrep=false){
   return start(plan.work,inbound+'/items/prepDetails','POST',
    {marketplaceId:marketplace,mskuPrepDetails:unset.map(msku=>({msku,prepCategory:'NONE',prepTypes:['ITEM_NO_PREP']}))},
    {action:'setupPrep',...(createAfterPrep?{createAfterPrep}:{})});
  }
  function startCreate(owners:PrepDetails['owners']){
   return start({...plan.work,owners},inbound+'/inboundPlans','POST',{name:plan.name,sourceAddress:senders[plan.account],
    destinationMarketplaces:[marketplace],items:items.map(i=>lineItem(i,owners))},{action:'create'});
  }
  const reviewPrep=(details:PrepDetails)=>reply(200,{plan:planSelect(plan),prepReview:details});
  async function finishPrep(pending:Pending,problem='',terminal=false){
   const details=await (pending.createAfterPrep?createDetails():prep(api,items)).catch(async error=>{
    if(error instanceof WorkflowError&&error.status===422){
     await patch({pending:null,work:{...plan.work,notice:error.message}});return null;
    }
    throw error;
   });
   if(!details)return result();
   if(pending.createAfterPrep&&details.reviewRequired){
    await patch({pending:null});return reviewPrep(details);
   }
   if(details.unset.length){
    const numbers=details.unset.map(sku=>sku.split('-')[0]).join('、');
    const notice=`Amazonで梱包不要を確認できない商品：${numbers}。`+(problem||'時間をおいてから再試行してください。');
    if(!pending.op)return invalid(notice);
    if(terminal||Date.now()-Date.parse(pending.at)>120000)await patch({pending:null,work:{...plan.work,notice}});
    return result();
   }
   if(pending.createAfterPrep)await startCreate(details.owners);
   else await patch({pending:null,work:{...plan.work,notice:undefined}});
   return result();
  }
  if(action==='recover'){
   const pending=plan.pending;
   if(!pending||pending.op||Date.now()-Date.parse(pending.at)<30000) return invalid('Amazonの受付を確認中です。少し待ってから再確認してください。');
   if(pending.action==='create'){
    const candidates=(await api.call(inbound+'/inboundPlans',{pageSize:'30'})).inboundPlans??[];
    const matches=[];
    for(const row of candidates.filter((r:any)=>r.name===plan.name&&r.marketplaceIds?.includes(marketplace)&&r.status!=='VOIDED'&&
      Math.abs(Date.parse(r.createdAt)-Date.parse(pending.at))<120000)){
     const remote=await api.pages(planPath(row.inboundPlanId)+'/items','items');
     if(remote.length===items.length&&items.every(i=>remote.some(x=>x.msku===i.sku&&x.asin===i.asin&&x.quantity===1)))matches.push(row);
    }
    if(matches.length!==1)return invalid('Amazonの納品履歴で同じSKUの納品を確認できません。時間をおいて再確認してください。');
    await patch({pending:null,stage:'created',amazon_id:matches[0].inboundPlanId});return result();
   }
   const work=packingResult(plan.work,pending);
   if(pending.action==='setupPrep'){
    return finishPrep(pending);
   }else if(['packing','placements','transport','windows'].includes(pending.action)){
    // Regeneration only builds choices. No fee or shipment is confirmed.
    await patch({pending:null,work:{...work,notice:'候補の受付を確認できませんでした。候補を再取得してください。'}});return result();
   }else if(pending.action==='choosePacking'){
    const choices=await listPacking(api,path);
    if(!choices.some(choice=>choice.status==='ACCEPTED'&&choice.packingOptionId===pending.remote))
     return invalid('Amazonで梱包方法の確定結果を確認できません。時間をおいて再確認してください。');
   }else if(pending.action==='confirmPlacement'||pending.action==='cancel'){
    const remote=await api.call(path);
    if(pending.action==='cancel'&&remote.status==='VOIDED'){await cancel();return result();}
    if(pending.action==='cancel'||!remote.placementOptions?.some((choice:any)=>choice.status==='ACCEPTED'&&choice.placementOptionId===pending.remote))
     return invalid('Amazonで確定結果を確認できません。時間をおいて再確認してください。');
   }else if(pending.action==='boxes'||pending.action==='resizeBoxes'){
    const remote=await api.pages(path+'/boxes','boxes');
    const skuById=new Map(items.map(item=>[item.item_id,item.sku]));
    const boxKey=(length:number,width:number,height:number,weight:number,skus:string[])=>
     JSON.stringify([length,width,height,weight,[...skus].sort()]);
    const expected=(work.boxes??[]).map(box=>boxKey(box.length,box.width,box.height,box.weight,box.items.map(id=>skuById.get(id)!))).sort();
    const actual=remote.flatMap(box=>{
     const d=box.dimensions,w=box.weight;
     if(d?.unitOfMeasurement!=='CM'||w?.unit!=='KG'||(box.quantity??1)!==1||
       !Array.isArray(box.items)||!box.items.every((item:{msku?:string;quantity?:number})=>typeof item?.msku==='string'&&item.quantity===1))return [];
     return [boxKey(d.length,d.width,d.height,w.value,box.items.map((item:{msku:string})=>item.msku))];
    }).sort();
    if(!expected.length||actual.length!==remote.length||JSON.stringify(expected)!==JSON.stringify(actual))
     return invalid('Amazonで箱の寸法・重量・商品を照合できません。時間をおいて再確認してください。');
   }else if(pending.action==='confirmTransport'){
    for(const option of work.selections??[]){
     const shipment=await api.call(shipmentPath(plan,option.shipmentId));
     if(shipment.selectedTransportationOptionId!==option.id||!shipment.shipmentConfirmationId)
      return invalid('Amazonで配送の確定を確認できません。時間をおいて再確認してください。');
    }
   }else if(pending.action==='chooseWindow'||pending.action==='tracking'){
    const shipment=await api.call(shipmentPath(plan,pending.shipmentId!));
    if(pending.action==='chooseWindow'){
     if(shipment.selectedDeliveryWindow?.deliveryWindowOptionId!==pending.windowId)return invalid('Amazonで到着期間を確認できません。');
     work.selectedWindows={...work.selectedWindows,[pending.shipmentId!]:pending.windowId!};
    }else{
     const tracking=shipment.trackingDetails?.spdTrackingDetail?.spdTrackingItems??[];
     if(!Object.entries(pending.tracking??{}).every(([id,value])=>tracking.some((box:any)=>box.boxId===id&&box.trackingId===value)))
      return invalid('Amazonで追跡番号を確認できません。時間をおいて再確認してください。');
     work.shipments=await getShipments(api,plan,true);
    }
   }else return invalid('セラーセントラルでAmazonの受付結果を確認してください。');
   await patch({pending:null,stage:stageAfter[pending.action]??plan.stage,work});return result();
  }
  if(action==='poll'){
   const pending=plan.pending!;
   if(!pending.op)throw new WorkflowError(409,'Amazonから受付番号を取得できていません。二重登録を防ぐため納品履歴を確認してください。');
   const operation=await api.call(inbound+'/operations/'+enc(pending.op));
   if(operation.operationStatus==='IN_PROGRESS')return result();
   if(operation.operationStatus==='FAILED'){
    const detail=(operation.operationProblems??[]).map(amazonProblem).filter(Boolean).slice(0,4).join('／');
    if(pending.action==='create')await patch({pending:null,amazon_id:null,work:{...plan.work,notice:detail||'Amazonで納品作成に失敗しました。'}});
    else if(pending.action==='setupPrep')await patch({pending:null,work:{...plan.work,notice:'Amazonで梱包不要の登録に失敗しました。'+detail}});
    else await patch({pending:null,work:{...plan.work,notice:detail||'Amazonで処理が失敗しました。'}});
    return result();
   }
   if(operation.operationStatus!=='SUCCESS')throw new WorkflowError(502,'Amazonの処理状態を確認できません。');
   if(pending.action==='cancel'){await cancel();return result();}
   if(pending.action==='setupPrep'){
    const problems:({severity?:string}|null)[]=Array.isArray(operation.operationProblems)?operation.operationProblems:[];
    return finishPrep(pending,problems.map(amazonProblem).filter(Boolean).slice(0,4).join('／'),problems.some(x=>x?.severity==='ERROR'));
   }
   const work=packingResult(plan.work,pending);
   if(pending.action==='packing')work.packing=(await availablePacking(api,path)).map(x=>({id:x.packingOptionId,groups:x.packingGroups,fees:charges(x.fees),expiration:x.expiration}));
   if(pending.action==='placements')work.placements=(await api.pages(path+'/placementOptions','placementOptions',optionPageSize)).filter(x=>x.status==='OFFERED').map(x=>({id:x.placementOptionId,shipmentIds:x.shipmentIds,fees:charges(x.fees),expiration:x.expiration}));
   if(pending.action==='transport'){
    const all=await api.pages(path+'/transportationOptions','transportationOptions',{...optionPageSize,placementOptionId:work.placement!.id});
    work.transport=all.filter(x=>smallParcel.includes(x.shippingMode)&&validSolutions.includes(x.shippingSolution))
      .map(x=>({id:x.transportationOptionId,shipmentId:x.shipmentId,carrier:x.carrier?.name??x.carrier?.alphaCode??'配送会社指定なし',
       carrierCode:x.carrier?.alphaCode,solution:x.shippingSolution,quote:charge(x.quote?.cost),expiration:x.quote?.expiration,preconditions:x.preconditions??[]}));
    work.shipments=await getShipments(api,plan,false);
   }
   if(pending.action==='windows'){
    const rows=await api.pages(shipmentPath(plan,pending.shipmentId!)+'/deliveryWindowOptions','deliveryWindowOptions',{pageSize:'100'});
    work.windows={...work.windows,[pending.shipmentId!]:rows.filter(x=>!expired(x.validUntil)).map(x=>({id:x.deliveryWindowOptionId,start:x.startDate,end:x.endDate,expiration:x.validUntil}))};
   }
   if(pending.action==='chooseWindow')work.selectedWindows={...work.selectedWindows,[pending.shipmentId!]:pending.windowId!};
   if(pending.action==='tracking')work.shipments=work.shipments?.map(s=>s.id!==pending.shipmentId?s:{...s,trackingSaved:true,
    boxes:s.boxes?.map(b=>({...b,tracking:pending.tracking?.[b.id]}))});
   await patch({pending:null,stage:stageAfter[pending.action]??plan.stage,work});return result();
  }
  if(action==='checkPrep'){
   eligiblePhase(plan,'draft');
   const found=await prep(api,items);
   return reply(200,found);
  }
  if(action==='setupPrep'){
   eligiblePhase(plan,'draft');
   if(input.confirmed!==true)return invalid('梱包カテゴリーの登録を確認してください。');
   const {unset}=await prep(api,items);
   if(!unset.length)return result();
   await setupPrep(unset);
   return result();
  }
  if(action==='create'){
   const details=await createDetails();
   if(details.reviewRequired&&input.acceptPrep!==true){
    if(input.autoPrep===true)return reviewPrep(details);
    return invalid('Amazonが指定した梱包・ラベル条件を確認してください。');
   }
   if(details.unset.length){
    if(input.autoPrep!==true)return invalid('梱包カテゴリーが未設定の商品があります。先に梱包条件を確認してください。');
    await setupPrep(details.unset,true);
   }else await startCreate(details.owners);
  }else if(action==='packing'){
   eligiblePhase(plan,'created','packing-options');await start(plan.work,path+'/packingOptions');
  }else if(action==='choosePacking'){
   eligiblePhase(plan,'packing-options');
   const choice=plan.work.packing?.find(option=>option.id===input.option);
   if(!choice||expired(choice.expiration)||(input.confirmed!==true&&input.automatic!==true)) return invalid('有効な梱包方法を確認して選択してください。');
   let groupIds=choice.groups;
   if(input.automatic===true){
    const candidates=await availablePacking(api,path);
    const [current]=candidates;
    if(candidates.length!==1||current?.packingOptionId!==choice.id||!Array.isArray(current.fees)||
      !current.fees.every((fee:{value?:unknown}|null)=>charge(fee?.value)?.amount===0)||
      !Array.isArray(current.packingGroups)||!current.packingGroups.length||current.packingGroups.some((id:unknown)=>typeof id!=='string'||!id))
     return invalid('Amazonの梱包候補または料金を確認してください。梱包方法を再取得してください。');
    groupIds=current.packingGroups;
   }
   const groups=await packingGroups(api,path,groupIds,items);
   await start({...plan.work,groups},path+'/packingOptions/'+enc(choice.id)+'/confirmation','POST',undefined,{remote:choice.id});
  }else if(action==='boxes'){
   eligiblePhase(plan,'packing-confirmed');
   if(!path||!plan.work.groups)return invalid('Amazonの梱包グループを確認できません。');
   const boxes=validateBoxes(input.boxes===undefined?plan.work.boxes:input.boxes,items,plan.work.groups);
   await start({...plan.work,boxes},path+'/packingInformation','POST',groupedBoxes(boxes,plan));
  }else if(action==='resizeBoxes'){
   if(!canResizeBoxes(plan.stage))throw new WorkflowError(409,'納品先の確定前に箱サイズを変更してください。');
   const saved=plan.work.boxes;
   const dimensions=input.dimensions;
   if(!path||!plan.work.groups||!saved?.length||!Array.isArray(dimensions)||dimensions.length!==saved.length)
    return invalid('登録済みの箱ごとに寸法と重量を入力してください。');
   const boxes=validateBoxes(saved.map((box,index)=>({...dimensions[index],items:box.items})),items,plan.work.groups);
   await start(plan.work,path+'/packingInformation','POST',groupedBoxes(boxes,plan),{boxes});
  }else if(action==='placements'){
   eligiblePhase(plan,'packed','placement-options','transport-options');
   await start({...plan.work,placement:undefined,transport:undefined,shipments:undefined,windows:undefined,selectedWindows:undefined},path+'/placementOptions','POST',{});
  }else if(action==='transport'){
   eligiblePhase(plan,'placement-options','transport-options');
   const placement=plan.work.placements?.find(option=>option.id===input.option);
   if(!placement||!placement.shipmentIds.length||expired(placement.expiration))return invalid('有効な納品先を選択してください。');
   const startAt=dateWindow(input.shipDate);
   const {name,phoneNumber}=senders[plan.account];
   await start({...plan.work,placement,shipDate:input.shipDate,transport:undefined,windows:undefined,selectedWindows:undefined},path+'/transportationOptions','POST',
    {placementOptionId:placement.id,shipmentTransportationConfigurations:placement.shipmentIds.map(shipmentId=>({shipmentId,readyToShipWindow:{start:startAt},contactInformation:{name,phoneNumber}}))});
  }else if(action==='confirmPlacement'){
   eligiblePhase(plan,'transport-options');
   if(!plan.work.placement||input.confirmed!==true)return invalid('配送方法・料金を確認してください。');
   const selections=transportSelection(input.options,plan.work.placement,plan.work.transport??[]);
   if(selections.some(unknownPrecondition))return invalid('選んだ配送方法にはセラーセントラルでの手続きが必要です。');
   if(selections.some(s=>s.solution==='AMAZON_PARTNERED_CARRIER'&&!s.quote))return invalid('Amazonから配送費を確認できません。配送方法を選び直してください。');
   await start({...plan.work,selections},path+'/placementOptions/'+enc(plan.work.placement.id)+'/confirmation','POST',undefined,{remote:plan.work.placement.id});
  }else if(action==='windows'||action==='chooseWindow'){
   eligiblePhase(plan,'placement-confirmed');
   const option=plan.work.selections?.find(s=>s.shipmentId===input.shipment);
   if(!option||!needsWindow(option))return invalid('納品先を選択してください。');
   const shipmentId=option.shipmentId;
   const remote=shipmentPath(plan,shipmentId)+'/deliveryWindowOptions';
   if(action==='windows')await start(plan.work,remote,'POST',undefined,{shipmentId});
   else{
    const window=plan.work.windows?.[shipmentId]?.find(w=>w.id===input.option);
    if(!window||expired(window.expiration))return invalid('有効な到着期間を選択してください。');
    await start(plan.work,remote+'/'+enc(window.id)+'/confirmation','POST',undefined,{shipmentId,windowId:window.id});
   }
  }else if(action==='confirmTransport'){
   eligiblePhase(plan,'placement-confirmed');
   const selections=plan.work.selections??[];
   if(input.confirmed!==true||!selections.length||selections.some(s=>expired(s.expiration)||(needsWindow(s)&&!plan.work.selectedWindows?.[s.shipmentId])))
    return invalid('有効な配送方法と到着期間を確認してください。');
   const {name,phoneNumber}=senders[plan.account];
   await start(plan.work,path+'/transportationOptions/confirmation','POST',{transportationSelections:selections.map(s=>
    ({shipmentId:s.shipmentId,transportationOptionId:s.id,contactInformation:{name,phoneNumber}}))});
  }else if(action==='refresh'){
   eligiblePhase(plan,'ready');
   const shipments=await getShipments(api,plan,true);
   await patch({work:{...plan.work,shipments,notice:undefined}});
   const ids=await checkPublished(api,plan,shipments);
   if(ids.length){
    const published=await db.rpc('publish_fba_inbound_items',{p_plan:plan.id,p_items:ids});
    if(published.error)throw new WorkflowError(502,'Amazonで購入可能ですが、在庫の更新ができませんでした。もう一度確認してください。');
   }
   await patch({work:{...plan.work,shipments}});plan=await read(plan.id);
  }else if(action==='label'){
   eligiblePhase(plan,'ready');
   if(!plan.work.placement?.shipmentIds.includes(input.shipment))return invalid('納品先を確認してください。');
   let shipment=plan.work.shipments?.find(s=>s.id===input.shipment);
   if(!shipment?.confirmationId||!shipment.boxes?.length)[shipment]=await getShipments(api,plan,true,[input.shipment]);
   if(!shipment?.confirmationId||!shipment.boxes?.length)return invalid('Amazonで配送ラベルを準備しています。時間をおいてから再試行してください。');
   const chosen=shipment.boxes.find(b=>b.id===input.box);
   if(input.box&&!chosen)return invalid('輸送箱を確認できません。');
   const boxIds=chosen?[chosen.id]:shipment.boxes.map(box=>box.id);
   const params={PageType:'PackageLabel_A4_4',LabelType:'UNIQUE',NumberOfPackages:String(shipment.boxes.length),
    PackageLabelsToPrint:boxIds.join(',')};
   const labels=await api.call('/fba/inbound/v0/shipments/'+enc(shipment.confirmationId)+'/labels',params);
   const document=await fetch(amazonPdfUrl(labels.payload?.DownloadURL),{redirect:'error',signal:AbortSignal.timeout(8000)});
   const raw=document.ok?await document.arrayBuffer():null;
   if(!raw||raw.byteLength>12000000||new TextDecoder().decode(raw.slice(0,5))!=='%PDF-')
    throw new WorkflowError(502,'Amazonの配送ラベルPDFを取得できません。もう一度お試しください。');
   return new Response(raw,{status:200,headers:{...headers,'Content-Type':'application/octet-stream'}});
  }else if(action==='tracking'){
   eligiblePhase(plan,'ready');
   const s=plan.work.shipments?.find(s=>s.id===input.shipment);
   const transport=plan.work.selections?.find(t=>t.shipmentId===input.shipment);
   if(input.confirmed!==true||!s?.boxes?.length||!transport||transport.solution!=='USE_YOUR_OWN_CARRIER'||['CANCELLED','CLOSED','DELETED','ABANDONED'].includes(s.status))return invalid('配送会社に引き渡した納品の追跡番号を確認してください。');
   const tracking:Record<string,string>={};
   for(const box of s.boxes){
    const value=input.tracking?.[box.id];
    if(typeof value!=='string'||!/^[A-Za-z0-9-]{4,60}$/.test(value.trim()))return invalid('すべての箱に配送会社の追跡番号を入力してください。');
    tracking[box.id]=value.trim();
   }
   await start(plan.work,shipmentPath(plan,s.id)+'/trackingDetails','PUT',{trackingDetails:{spdTrackingDetail:{spdTrackingItems:
    s.boxes.map(box=>({boxId:box.id,trackingId:tracking[box.id]}))}}},{shipmentId:s.id,tracking});
  }else if(action==='cancel'){
   if(!path||plan.stage==='ready'||plan.stage==='cancelled'||plan.work.shipments?.some(s=>shipped.includes(s.status)))return invalid('確定済みの配送の取消はセラーセントラルで行ってください。');
   await start(plan.work,path+'/cancellation','PUT');
  }else return reply(400,{error:'操作を確認できません。'});
  return result();
 }catch(error){
  return error instanceof WorkflowError||error instanceof AmazonAccountError?reply(error.status,{error:error.message})
   :reply(502,{error:'納品処理を確認できません。時間をおいて再試行してください。'});
 }
}
if(import.meta.main)Deno.serve(handler);
