import {handler} from './index.ts';
import {senders,type Plan} from './workflow.ts';

const assert=(value:unknown,message='assertion failed')=>{if(!value)throw new Error(message);};
const equal=(a:unknown,b:unknown)=>assert(JSON.stringify(a)===JSON.stringify(b),`Expected ${JSON.stringify(b)}; got ${JSON.stringify(a)}`);
const id='11710aa0-1111-4111-8111-111111111111',itemId='22720aa0-2222-4222-8222-222222222222';
const sku='2470-AAAA-20261107-400',asin='B015INS3IE',shipment='sh-test',market='A1VC38T7YXB528';
const json=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json'}});

Deno.test('FBA2 draft resumes through confirmed small parcel shipment, labels and received BUYABLE stock',async()=>{
 const original=globalThis.fetch;
 const env:Record<string,string>={SUPABASE_URL:'https://database.invalid',SUPABASE_ANON_KEY:'anon',SUPABASE_SERVICE_ROLE_KEY:'service',
  AMAZON_2_LWA_CLIENT_ID:'fba2',AMAZON_2_LWA_CLIENT_SECRET:'secret',AMAZON_2_LWA_REFRESH_TOKEN:'fba2refresh',AMAZON_2_SELLER_ID:'A3E7BXJWH9TP11'};
 for(const [key,value] of Object.entries(env))Deno.env.set(key,value);
 let plan:Plan={id,account:'FBA2',name:'担当者2026/11/7',staff_id:'own',stage:'draft',revision:0,created_at:'',amazon_id:null,pending:null,work:{},
  fba_inbound_items:[{item_id:itemId,sku,asin,title:'商品',condition:'非常に良い',sales_channel:'FBA2'}]};
 let received=0,available=0,buyable=false,published=0,remoteCalls=0,failAfterCreate=false,ambiguousPacking=false,staff='own';
 let prepCategory='NONE',inventoryChanged=false,prepRejected=false,labelRequired=false;
 const box={length:40,width:30,height:20,weight:4,items:[itemId]};
 const requests:{path:string;method:string;body:any}[]=[];
 globalThis.fetch=async(input,init)=>{
  const url=new URL(input instanceof Request?input.url:String(input));
  const method=init?.method??'GET',path=url.pathname;
  const body=typeof init?.body==='string'&&init.body.startsWith('{')?JSON.parse(init.body):null;
  if(url.hostname==='database.invalid'){
   if(path==='/auth/v1/user')return json({id:'user'});
   if(path.endsWith('/current_staff_id'))return json(staff);
   if(path.endsWith('/staff'))return json({id:staff,is_active:true,role:'deliverer'});
   if(path.endsWith('/items'))return json([{id:itemId,sku,asin,condition:'非常に良い',sales_channel:'FBA2',status:inventoryChanged?'販売済':'商品登録前',deliverer_id:'own'}]);
   if(path.endsWith('/fba_inbound_plans')){
    if(method==='PATCH'){equal(url.searchParams.get('revision'),'eq.'+plan.revision);plan={...plan,...body};}
    return json(plan);
   }
   if(path.endsWith('/publish_fba_inbound_items')){equal(body.p_items,[itemId]);published++;plan.fba_inbound_items[0].published_at='verified';return json(1);}
   throw new Error(path);
  }
  if(url.hostname==='api.amazon.com'){assert(String(init?.body).includes('refresh_token=fba2refresh'));return json({access_token:'for-fba2'});}
  if(url.hostname==='labels.s3.amazonaws.com')return new Response('%PDF-test');
  equal(url.hostname,'sellingpartnerapi-fe.amazon.com');
  equal(new Headers(init?.headers).get('x-amz-access-token'),'for-fba2');
  assert(/^\d{8}T\d{6}Z$/.test(new Headers(init?.headers).get('x-amz-date')??''),'SP-API requests include their UTC timestamp');
  remoteCalls++;requests.push({path,method,body});
  if(path.endsWith('/items/prepDetails')){
   if(method==='POST'){
    equal(body,{marketplaceId:market,mskuPrepDetails:[{msku:sku,prepCategory:'NONE',prepTypes:['ITEM_NO_PREP']}]});
    return json({operationId:'prep-op'},202);
   }
   equal(url.searchParams.getAll('mskus'),[plan.fba_inbound_items.map(item=>item.sku).join(',')]);
   const requested=url.searchParams.get('mskus')!.split(',');
   const prepTypes=prepCategory==='NONE'?(labelRequired?['ITEM_LABELING','ITEM_NO_PREP']:['ITEM_NO_PREP']):['ITEM_BUBBLEWRAP'];
   return json({mskuPrepDetails:prepCategory?requested.map(msku=>({msku,prepCategory,prepTypes})):[]});
  }
  if(path.endsWith('/inboundPlans')&&method==='POST'){
   equal(body.sourceAddress,senders.FBA2);
   equal(body.destinationMarketplaces,[market]);
   equal(body.items,[{msku:sku,quantity:1,prepOwner:labelRequired?'SELLER':'NONE',labelOwner:'SELLER'}]);
   if(failAfterCreate)throw new Error('response lost');
   return json({operationId:'create-op',inboundPlanId:'wf-test'},202);
  }
  if(path.includes('/operations/'))return json({operationStatus:'SUCCESS',operationProblems:prepRejected?[{severity:'ERROR',code:'PREP_REJECTED',message:'SKUの梱包を確認してください'}]:[]});
  if(path.endsWith('/packingOptions')&&method==='GET')return json({packingOptions:[{packingOptionId:'packing',status:'OFFERED',packingGroups:['group'],fees:[]}]});
  if(path.endsWith('/packingOptions')&&ambiguousPacking)throw new Error('response lost');
  if(path.endsWith('/packingGroups/group/items'))return json({items:[{msku:sku,asin,quantity:1}]});
  if(path.endsWith('/packingInformation'))equal(body.packageGroupings,[{packingGroupId:'group',boxes:[{contentInformationSource:'BOX_CONTENT_PROVIDED',
    dimensions:{length:40,width:30,height:20,unitOfMeasurement:'CM'},weight:{value:4,unit:'KG'},quantity:1,items:[{msku:sku,quantity:1,prepOwner:labelRequired?'SELLER':'NONE',labelOwner:'SELLER'}]}]}]);
  if(path.endsWith('/placementOptions')&&method==='GET')return json({placementOptions:[{placementOptionId:'placement',shipmentIds:[shipment],status:'OFFERED',fees:[]}]});
  if(path.endsWith('/transportationOptions')&&method==='POST'){
   equal(body.shipmentTransportationConfigurations[0].readyToShipWindow.start,plan.work.shipDate+'T00:00:00.000Z');
   equal(plan.work.transport,undefined);
  }
  if(path.endsWith('/transportationOptions')&&method==='GET')return json({transportationOptions:[
    {transportationOptionId:'transport',shipmentId:shipment,carrier:{name:'配送会社',alphaCode:'YAMATO'},shippingMode:'GROUND_SMALL_PARCEL',shippingSolution:'USE_YOUR_OWN_CARRIER',preconditions:['CONFIRMED_DELIVERY_WINDOW']},
    {transportationOptionId:'pallet',shipmentId:shipment,carrier:{name:'ヤマト運輸'},shippingMode:'FREIGHT_LTL',shippingSolution:'USE_YOUR_OWN_CARRIER',preconditions:[]},
  ]});
  if(path.endsWith('/'+shipment))return json({shipmentId:shipment,placementOptionId:'placement',status:received?'RECEIVING':'WORKING',
    shipmentConfirmationId:'FBA123',destination:{warehouseId:'TEST'}});
  if(path.endsWith('/deliveryWindowOptions')&&method==='GET')return json({deliveryWindowOptions:[{deliveryWindowOptionId:'window',startDate:'2030-01-03T00:00:00Z',endDate:'2030-01-05T00:00:00Z',validUntil:'2030-01-01T00:00:00Z'}]});
  if(path.endsWith('/'+shipment+'/boxes'))return json({boxes:[{boxId:'box',items:[{msku:sku}]}]});
  if(path.endsWith('/FBA123/labels')){
   equal(url.searchParams.get('NumberOfPackages'),'1');
   assert([null,'box'].includes(url.searchParams.get('PackageLabelsToPrint')));
   return json({payload:{DownloadURL:'https://labels.s3.amazonaws.com/test.pdf'}});
  }
  if(path.endsWith('/trackingDetails'))equal(body.trackingDetails.spdTrackingDetail.spdTrackingItems,[{boxId:'box',trackingId:'ABCD12345'}]);
  if(path.endsWith('/FBA123/items'))return json({payload:{ItemData:[{SellerSKU:sku,QuantityReceived:received}]}});
  if(path==='/fba/inventory/v1/summaries')return json({payload:{inventorySummaries:[{sellerSku:sku,asin,inventoryDetails:{fulfillableQuantity:available}}]}});
  if(path.includes('/listings/2021-08-01/items/A3E7BXJWH9TP11/'))return json({sku,summaries:[{asin,marketplaceId:market,status:buyable?['BUYABLE']:['DISCOVERABLE']}]});
  if(method!=='GET')return json({operationId:'operation-id'},202);
  throw new Error(path);
 };
 async function send(action:string,fields:Record<string,unknown>={},status=200){
  const res=await handler(new Request('https://function.invalid',{method:'POST',headers:{authorization:'Bearer fixture'},
   body:JSON.stringify({action,id,revision:plan.revision,...fields})}));
  if(res.status!==status)throw new Error(action+' returned '+res.status+' '+await res.text());
  return res;
 }
 async function step(action:string,stage:Plan['stage'],fields:Record<string,unknown>={}){
  await send(action,fields);assert(plan.pending?.op,action+' should persist the operation');
  await send('poll');equal(plan.stage,stage);equal(plan.pending,null);
 }
 try{
  staff='other';await send('get',{},404);equal(remoteCalls,0);staff='own';
  const extra={...plan.fba_inbound_items[0],item_id:'33730aa0-3333-4333-8333-333333333333',sku:'2471-AAAA-20261107-400'};
  plan.fba_inbound_items.push(extra);
  const prep=await (await send('checkPrep')).json();
  equal(prep.unset,[]);
  equal(prep.owners[extra.item_id],{prepOwner:'NONE',labelOwner:'SELLER'});
  plan.fba_inbound_items.pop();
  await send('saveBoxes',{boxes:[box,box]},422);equal(plan.work.boxes,undefined);
  await send('saveBoxes',{boxes:[box]});await send('saveBoxes',{boxes:[box],revision:0},409);
  failAfterCreate=true;await send('create',{},502);await send('create',{},409);
  equal(requests.filter(r=>r.path.endsWith('/inboundPlans')&&r.method==='POST').length,1);
  // Restore the draft to exercise the separate, opt-in automatic prep path.
  plan={...plan,pending:null};failAfterCreate=false;
  const writes=()=>requests.filter(r=>r.method==='POST').length;
  const before=writes();
  prepCategory='FRAGILE';
  const review=await (await send('create',{autoPrep:true})).json();
  equal(review.prepReview.requirements[itemId],['FRAGILE','ITEM_BUBBLEWRAP']);
  equal(writes(),before);equal(plan.pending,null);
  prepCategory='';await send('create',{},422);equal(writes(),before);
  await send('create',{autoPrep:true});
  equal(plan.pending?.action,'setupPrep');equal(plan.pending?.createAfterPrep,true);equal(plan.pending?.op,'prep-op');
  await send('create',{autoPrep:true},409);await send('poll');equal(plan.pending?.op,'prep-op');equal(writes(),before+1);
  prepRejected=true;await send('poll');equal(plan.pending,null);equal(plan.stage,'draft');
  assert(plan.work.notice?.includes('2470')&&plan.work.notice?.includes('PREP_REJECTED'));equal(writes(),before+1);
  prepRejected=false;await send('create',{autoPrep:true});
  inventoryChanged=true;prepCategory='NONE';await send('poll');
  equal(plan.pending,null);equal(plan.stage,'draft');assert(plan.work.notice?.includes('商品の情報が変更'));equal(writes(),before+2);
  inventoryChanged=false;prepCategory='';await send('create',{autoPrep:true});
  prepCategory='NONE';labelRequired=true;
  await send('poll');equal(plan.pending?.action,'create');equal(plan.pending?.op,'create-op');equal(plan.amazon_id,'wf-test');
  await send('create',{autoPrep:true},409);await send('poll');equal(plan.stage,'created');equal(plan.pending,null);equal(writes(),before+4);
  ambiguousPacking=true;await send('packing',{},502);await send('packing',{},409);
  plan.pending!.at='2020-01-01T00:00:00Z';await send('recover');ambiguousPacking=false;
  await step('packing','packing-options');await send('choosePacking',{option:'packing'},422);
  await step('choosePacking','packing-confirmed',{option:'packing',confirmed:true});await step('boxes','packed');
  await step('placements','placement-options');await step('transport','transport-options',{option:'placement',shipDate:'2030-01-01'});
  equal(plan.work.transport?.map(t=>[t.id,t.carrierCode]),[['transport','YAMATO']]);
  await step('transport','transport-options',{option:'placement',shipDate:'2030-01-02'});
  await send('confirmPlacement',{options:['transport']},422);
  await step('confirmPlacement','placement-confirmed',{options:['transport'],confirmed:true});
  await send('confirmTransport',{confirmed:true},422);
  await step('windows','placement-confirmed',{shipment});await step('chooseWindow','placement-confirmed',{shipment,option:'window'});
  await step('confirmTransport','ready',{confirmed:true});
  const revisionBeforePrint=plan.revision;
  equal(await (await send('label',{shipment})).text(),'%PDF-test');
  equal(plan.revision,revisionBeforePrint);assert(!plan.work.shipments?.[0].boxes);
  await send('refresh');
  equal(published,0);equal(plan.work.shipments?.[0].status,'WORKING');
  const pdf=await send('label',{shipment,box:'box'});equal(await pdf.text(),'%PDF-test');
  await send('tracking',{shipment,tracking:{box:'ABCD12345'}},422);
  await step('tracking','ready',{shipment,confirmed:true,tracking:{box:'ABCD12345'}});
  received=1;await send('refresh');equal(published,0);
  available=1;await send('refresh');equal(published,0);
  buyable=true;await send('refresh');equal(published,1);
  await send('refresh');equal(published,1);
 }finally{
  globalThis.fetch=original;for(const key of Object.keys(env))Deno.env.delete(key);
 }
});
