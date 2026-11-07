import {handler,listingBody,verifiedListing,offerImages,verifiedImages,inspectReceipt,effectivePrice,receiptPricePatch,repairReceiptPrice,type ListingItem} from './index.ts';
const assert=(v:unknown,m='assertion failed')=>{if(!v)throw Error(m)};
const id='11111111-1111-4111-8111-111111111111',requestId='22222222-2222-4222-8222-222222222222',market='A1VC38T7YXB528';
const item=():ListingItem=>({id,sku:'100000-AAAA-20261106-35',asin:'B015INS3IE',condition:'非常に良い',description:'説明\\n本文',planned_price:400,sales_channel:'FBA2',status:'商品登録前',is_accessory:false,deliverer_id:'staff',purchased_at:'2026-10-01'});
const photoId='55555555-5555-4555-8555-555555555555',photoUrl='https://test.supabase.co/storage/v1/object/sign/item-photos/photo.jpg?token=test';
const listing=(i=item())=>({sku:i.sku,summaries:[{marketplaceId:market,productType:'HVAC_AIR_FILTER',asin:i.asin,conditionType:'used_very_good'}],offers:[{marketplaceId:market,offerType:'B2C',price:{currencyCode:'JPY',amount:i.planned_price}}],attributes:{...listingBody(i).attributes,...offerImages([photoUrl])},issues:[]});
Deno.test('in-stock FBM requires an effective B2C price; stored attributes alone cannot complete listing',()=>{
 const i={...item(),sales_channel:'自己発送2'},remote=listing(i);
 assert(verifiedListing(remote,i));
 for(const offers of[[],[{marketplaceId:market,offerType:'B2C',price:{currencyCode:'JPY',amount:0}}],[{marketplaceId:market,offerType:'B2B',price:{currencyCode:'JPY',amount:400}}]]){
  remote.offers=offers;assert(effectivePrice(remote)===null);assert(!verifiedListing(remote,i));
 }
 assert(verifiedListing({...listing(),offers:[]},item()),'FBA stock not received must not require a live offer');
});
Deno.test('Amazon Decimal strings verify whole-yen prices without accepting invalid or fractional amounts',()=>{
 const i={...item(),sales_channel:'自己発送2'},remote:any=listing(i);
 for(const raw of['400','400.0','400.00',400]){remote.offers[0].price.amount=raw;assert(effectivePrice(remote)===400);assert(verifiedListing(remote,i));}
 for(const raw of['0','0.0','400.5','4e2','400円','',null,'9007199254740993',Infinity]){remote.offers[0].price.amount=raw;assert(effectivePrice(remote)===null);assert(!verifiedListing(remote,i));}
});
Deno.test('receipt price patch preserves business offers and price rules and uses actual product type',()=>{
 const remote=listing();Object.assign(remote.attributes.purchasable_offer[0],{minimum_seller_allowed_price:[{schedule:[{value_with_tax:300}]}],automated_pricing_merchandising_rule_plan:[{value:'rule'}]});
 (remote.attributes.purchasable_offer as any[]).push({audience:'B2B',marketplace_id:market,currency:'JPY',our_price:[{schedule:[{value_with_tax:380}]}]});
 const before=JSON.stringify(remote),patch=receiptPricePatch(remote,390);
 assert(patch.productType==='HVAC_AIR_FILTER');assert(patch.patches.length===1&&patch.patches[0].path==='/attributes/purchasable_offer');
 assert(patch.patches[0].value[0].our_price[0].schedule[0].value_with_tax===390);assert(patch.patches[0].value[1].our_price[0].schedule[0].value_with_tax===380);assert(patch.patches[0].value[0].minimum_seller_allowed_price[0].schedule[0].value_with_tax===300);assert(JSON.stringify(remote)===before);
 for(const price of[0,-1,1.5]){let rejected=false;try{receiptPricePatch(remote,price)}catch{rejected=true}assert(rejected);}
});
for(const mode of['accepted','timeout','concurrent','stale','wrongSku','failed','alreadyLive','feedAccepted','feedTimeout','feedEarly'])Deno.test('receipt price repair '+mode,async()=>{
 const current={...item(),sku:'100001-AAAA-20261106-34',sales_channel:'自己発送2',planned_price:390},r={request_id:requestId,item_id:id,sku:'100001-AAAA-20261106-40',asin:current.asin,price:390,item_condition:current.condition,sales_channel:current.sales_channel,seller_id:'A3E7BXJWH9TP11',state:mode==='failed'?'failed':'accepted',note:'original receipt'};
 if(mode.startsWith('feed'))r.note='Amazon価格補正:'+JSON.stringify({state:'accepted',startedAt:new Date(Date.now()-(mode==='feedEarly'?0:900000)).toISOString(),price:390,sku:r.sku,submissionId:'patch-1',previousNote:'original receipt'});
 let writes=0,previews=0,itemReads=0;const original=listing({...current,sku:r.sku});if(mode!=='alreadyLive')original.offers=[];
 const svc={from(table:string){let update:any=null,oldNote:any=undefined;const q:any={select(){return q},eq(k:string,v:unknown){if(k==='note')oldNote=v;return q},is(){return q},update(v:any){assert(table==='amazon_listing_submissions','must not mutate inventory');update=v;return q},maybeSingle:async()=>{if(update){if(mode==='concurrent'||oldNote!==r.note)return{data:null};r.note=update.note;return{data:{request_id:requestId}};}return{data:r}},single:async()=>({data:{...current,...(mode==='stale'&&++itemReads>1?{planned_price:500}:{})}}),then(resolve:any){if(update&&oldNote===r.note)r.note=update.note;return Promise.resolve({data:null}).then(resolve)}};return q;}};
 const api={sellerId:r.seller_id,get:async()=>original,submitPriceFeed:async(sku:string,payload:any)=>{assert(sku===r.sku&&payload.patches.length===1&&payload.patches[0].path==='/attributes/purchasable_offer');assert(JSON.parse(r.note.slice('Amazon価格補正:'.length)).feed.state==='sending');writes++;if(mode==='feedTimeout')throw Error('timeout');return{status:'ACCEPTED',feedId:'feed-1'};},patchPrice:async(sku:string,payload:any,preview=false)=>{assert(sku===r.sku&&sku!==current.sku);assert(payload.patches[0].value[0].our_price[0].schedule[0].value_with_tax===390);if(preview){previews++;return{status:'VALID'}}assert(!mode.startsWith('feed'),'feed fallback must not repeat a live PATCH');writes++;assert(r.note.startsWith('Amazon価格補正:'),'durable reservation before live write');if(mode==='timeout')throw Error('timeout');return{status:'ACCEPTED',submissionId:'repair-1'}}};
 const input={action:mode.startsWith('feed')?'repair-receipt-price-feed':'repair-receipt-price',itemId:id,requestId,expectedSku:mode==='wrongSku'?current.sku:r.sku,expectedCurrentSku:current.sku,expectedPrice:390};
 let result:any;try{result=await repairReceiptPrice(svc,input,async()=>api as any);}catch{assert(!['accepted','alreadyLive','feedAccepted'].includes(mode));}
 if(mode==='accepted'){assert(result.accepted&&!result.verified&&result.written);assert(writes===1);await repairReceiptPrice(svc,input,async()=>api as any);assert(writes===1&&previews===1,'retry must read only');}
 else if(['timeout','feedTimeout','feedAccepted'].includes(mode)){assert(writes===1);await repairReceiptPrice(svc,input,async()=>api as any);assert(writes===1);if(mode==='feedAccepted')assert(result.feedId==='feed-1'&&!result.verified);}
 else assert(writes===0);
 if(mode==='alreadyLive')assert(result.verified&&previews===0);
});
Deno.test('Internal inspection reads original receipt SKU and current SKU without writes or photo URLs',async()=>{
 const current={...item(),sku:'100001-AAAA-20261106-34'},receipt={request_id:requestId,item_id:id,sku:'100001-AAAA-20261106-40',asin:current.asin,price:390,item_condition:current.condition,sales_channel:'自己発送2',seller_id:'A3E7BXJWH9TP11',state:'accepted'};
 const svc={from(table:string){const query={select(){return query},eq(){return query},maybeSingle:()=>Promise.resolve({data:receipt}),single:()=>Promise.resolve({data:current})};assert(['items','amazon_listing_submissions'].includes(table));return query;}};
 const calls:string[]=[];const result=await inspectReceipt(svc,{action:'inspect-receipt',itemId:id,requestId},async()=>({sellerId:receipt.seller_id,get:async(sku:string)=>{calls.push(sku);return{...listing(current),sku};}}) as any);
 assert(calls.join(',')===[receipt.sku,current.sku].join(','));assert(result.receipt.price===390);assert(!JSON.stringify(result).includes('token=test'));
});
Deno.test('Internal inspection rejects cancelled receipt and wrong action before Amazon',async()=>{
 let calls=0;const svc={from(){const q={select(){return q},eq(){return q},maybeSingle:()=>Promise.resolve({data:{state:'failed'}})};return q;}};
 for(const action of['inspect-receipt','submit']){try{await inspectReceipt(svc,{action,itemId:id,requestId},async()=>{calls++;throw Error('must not connect')});throw Error('should reject');}catch(e){assert((e as Error).message!=='should reject');}}assert(calls===0);
});
Deno.test('private receipt actions reject missing or wrong dispatcher credentials before reading inventory',async()=>{
 const original=globalThis.fetch,keys=['SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY'],saved=keys.map(k=>Deno.env.get(k));let calls=0;
 try{
  Deno.env.set('SUPABASE_URL','https://test.supabase.co');Deno.env.set('SUPABASE_SERVICE_ROLE_KEY','test-service');
  globalThis.fetch=(async(input:RequestInfo|URL)=>{calls++;assert(String(input).includes('/rpc/delivery_push_config'));return new Response(JSON.stringify({delivery_push_dispatch_token:'private-dispatch'}),{headers:{'content-type':'application/json'}})}) as typeof fetch;
  for(const value of['','wrong']){const r=await handler(new Request('https://local',{method:'POST',headers:{'x-delivery-dispatch':value},body:JSON.stringify({action:'repair-receipt-price',itemId:id,requestId})}));assert(r.status===401);assert(!JSON.stringify(await r.json()).includes('private-dispatch'));}
  const r=await handler(new Request('https://local',{method:'POST',body:JSON.stringify({action:'repair-receipt-price',itemId:id,requestId})}));assert(r.status===401);assert(calls===2);
 }finally{globalThis.fetch=original;keys.forEach((k,i)=>saved[i]===undefined?Deno.env.delete(k):Deno.env.set(k,saved[i]!));}
});
Deno.test('offer uses selected seller/ASIN/price/condition and FBA has no invented quantity',()=>{const fba=listingBody(item());assert(fba.attributes.fulfillment_availability[0].fulfillment_channel_code==='AMAZON_JP');assert(!('quantity'in fba.attributes.fulfillment_availability[0]));assert(fba.attributes.purchasable_offer[0].our_price[0].schedule[0].value_with_tax===400);assert(fba.attributes.condition_note[0].value==='説明\n本文');const self=listingBody({...item(),sales_channel:'自己発送2'});assert(self.attributes.fulfillment_availability[0].quantity===1);assert(self.attributes.fulfillment_availability[0].fulfillment_channel_code==='DEFAULT')});
Deno.test('ASIN safety values are copied without inventing missing declarations',()=>{const empty=listingBody(item(),{attributes:{}}).attributes;assert(!('batteries_required'in empty));assert(!('supplier_declared_dg_hz_regulation'in empty));const known=listingBody(item(),{attributes:{batteries_required:[{value:false}],supplier_declared_dg_hz_regulation:[{value:'not_applicable'}]}}).attributes;assert(known.batteries_required[0].value===false);assert(known.supplier_declared_dg_hz_regulation[0].value==='not_applicable')});
Deno.test('verification checks SKU, ASIN, price, condition, channel and asynchronous issues',()=>{for(const change of ['sku','asin','price','condition','fulfillment','error']){const x=listing();if(change==='sku')x.sku='wrong';if(change==='asin')x.summaries[0].asin='B000WRONG1';if(change==='price')x.attributes.purchasable_offer[0].our_price[0].schedule[0].value_with_tax=401;if(change==='condition')x.summaries[0].conditionType='new_new';if(change==='fulfillment')x.attributes.fulfillment_availability=[{fulfillment_channel_code:'DEFAULT'}];if(change==='error')(x.issues as any[]).push({severity:'ERROR',code:'123',message:'missing data'});assert(!verifiedListing(x,item()),change)}assert(verifiedListing(listing(),item()))});
for(const mode of ['anonymous','inactive','other','photo','invalidPrice','invalidDate','wrongSeller','previewRejected','getForbidden','conflict','pending','timeout','putRejected','asynchronousError','summaryPending','registered','verified','stale','completeFailed','changedSku','changedSkuPending','changedDetails','photoMissing','photoRejected','photoWaiting','foreignPhoto','packingPhoto','expectedPrice','expectedSku','resumeSummary','resumePhotos','resumeLivePrice','resumeReady','resumeMissing','resumeChanged','resumeVerified'])Deno.test(mode,async()=>{
 const savedFetch=globalThis.fetch,keys=['SUPABASE_URL','SUPABASE_ANON_KEY','SUPABASE_SERVICE_ROLE_KEY',...['AMAZON_','AMAZON_2_'].flatMap(p=>['LWA_CLIENT_ID','LWA_CLIENT_SECRET','LWA_REFRESH_TOKEN','SELLER_ID'].map(k=>p+k))],saved=keys.map(k=>Deno.env.get(k));
 let patches=0,preview=0,puts=0,complete=0,record:Record<string,any>|null=null,itemReads=0,external=0;const current=item();if(mode==='resumeLivePrice')current.sales_channel='自己発送2';if(mode==='changedSku'||mode==='changedSkuPending'||mode==='changedDetails'){record={request_id:'33333333-3333-4333-8333-333333333333',item_id:id,sku:current.sku,asin:current.asin,sales_channel:current.sales_channel,account_id:'amazon-2',seller_id:'A3E7BXJWH9TP11',price:current.planned_price,item_condition:current.condition,description:current.description,work_completed_on:'2026-11-06',state:'accepted'};if(mode==='changedDetails')current.condition='良い';else{current.sku='100001-AAAA-20261106-35';current.sales_channel='自己発送2';}}if(mode==='invalidPrice')current.planned_price=0;if(mode.startsWith('resume')&&mode!=='resumeMissing'){record={request_id:requestId,item_id:id,sku:current.sku,asin:current.asin,sales_channel:current.sales_channel,account_id:'amazon-2',seller_id:'A3E7BXJWH9TP11',price:current.planned_price,item_condition:current.condition,description:current.description,work_completed_on:'2026-11-06',state:mode==='resumeVerified'?'verified':'accepted'};if(mode==='resumeChanged')current.planned_price=500;if(mode==='resumeVerified')current.status='出品中';}
 const json=(data:unknown,status=200)=>Promise.resolve(new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}}));
 try{
 Deno.env.set('SUPABASE_URL','https://test.supabase.co');Deno.env.set('SUPABASE_ANON_KEY','anon');Deno.env.set('SUPABASE_SERVICE_ROLE_KEY','service');for(const p of ['AMAZON_','AMAZON_2_'])for(const f of ['LWA_CLIENT_ID','LWA_CLIENT_SECRET','LWA_REFRESH_TOKEN','SELLER_ID'])Deno.env.set(p+f,f==='SELLER_ID'?(p==='AMAZON_'?'A1WI3OGPE43N2T':mode==='wrongSeller'?'A1WI3OGPE43N2T':'A3E7BXJWH9TP11'):'secret-value');
 globalThis.fetch=((input:RequestInfo|URL,init?:RequestInit)=>{const url=String(input),method=init?.method??'GET';
 if(url.includes('/auth/v1/user'))return json({id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',aud:'authenticated'});
 if(url.includes('/rpc/current_staff_id'))return json(mode==='other'?'someone':'staff');
 if(url.includes('/rpc/is_admin'))return json(false);
 if(url.includes('/rest/v1/staff'))return json({is_active:mode!=='inactive'});
 if(url.includes('/rest/v1/items')){itemReads++;return json({...current,...(mode==='stale'&&itemReads>1?{planned_price:500}:{})})}
 if(url.includes('/functions/v1/delivery-photo-drive'))return json({photos:[{id:photoId}]});
 if(url.includes('/rest/v1/item_photos'))return json([{id:photoId,storage_path:'photo.jpg',photo_kind:mode==='packingPhoto'?'packing':'product'}]);
 if(url.includes('/storage/v1/object/sign/'))return json([{path:'photo.jpg',signedURL:photoUrl.replace('https://test.supabase.co/storage/v1','')}]);
 if(url.includes('/rpc/listing_photos_approved'))return json(mode!=='photo');
 if(url.includes('/rest/v1/amazon_listing_submissions')){
  if(method==='POST'){assert(new Headers(init?.headers).get('authorization')==='Bearer service','only service records evidence');record=JSON.parse(String(init?.body));return json(record,201)}
  if(method==='PATCH'){assert(new Headers(init?.headers).get('authorization')==='Bearer service');Object.assign(record!,JSON.parse(String(init?.body)));return json(null)}
  if(url.includes('request_id=eq.'))return json(record&&decodeURIComponent(url).includes('request_id=eq.'+record.request_id)?record:null);
  return json(record&&['submitting','accepted','uncertain'].includes(record.state)?[record]:[]);
 }
 if(url.includes('/rpc/perform_dated_inventory_action')){if(mode==='changedSku')assert(JSON.parse(String(init?.body)).p_request_id===requestId,'old SKU proof must not complete current SKU');complete++;assert((record as Record<string,any>|null)?.state==='verified','never complete before verification');return mode==='completeFailed'?json({message:'failure',code:'42501'},403):json(null)}
 if(url.includes('/auth/o2/token'))return json({access_token:'test-token'});
 if(url.includes('/catalog/2022-04-01/items/'))return json({asin:current.asin,attributes:{batteries_required:[{value:false,marketplace_id:market}],supplier_declared_dg_hz_regulation:[{value:'not_applicable',marketplace_id:market}]}});
 external++;if((mode==='changedSku'||mode==='changedSkuPending'||mode==='changedDetails')&&url.includes(encodeURIComponent(item().sku)+'?')){const previous=listing(item());if(mode==='changedSkuPending')previous.summaries=[];return json(previous);}
 assert(url.includes('/items/A3E7BXJWH9TP11/'),'must use Amazon2');
 if(method==='PATCH'){const data=JSON.parse(String(init?.body));assert(data.productType==='HVAC_AIR_FILTER','photo patches use the actual SKU product type');assert(data.patches.every((p:any)=>/^\/attributes\/(main|other)_offer_image_locator/.test(p.path)),'patch photos only');if(url.includes('VALIDATION_PREVIEW'))return json({status:'VALID'});patches++;return json(mode==='photoRejected'?{status:'INVALID',issues:[{severity:'ERROR',code:'IMAGE',message:'写真確認'}]}:{status:'ACCEPTED'});}
 if(method==='PUT'){
  if(url.includes('VALIDATION_PREVIEW')){preview++;return json(mode==='previewRejected'?{status:'INVALID',issues:[{severity:'ERROR',code:'8541',message:'ASIN確認'}]}:{status:'VALID',issues:[]})}
  const submitted=JSON.parse(String(init?.body));assert(submitted.attributes.batteries_required[0].value===false);assert(submitted.attributes.supplier_declared_dg_hz_regulation[0].value==='not_applicable');
  puts++; if(mode==='timeout')throw new DOMException('Timeout','TimeoutError');return json(mode==='putRejected'?{status:'INVALID',issues:[{severity:'ERROR',code:'X',message:'内容確認'}]}:{status:'ACCEPTED',submissionId:'submission-1',issues:[]});
 }
 if(['resumeSummary','resumePhotos','resumeLivePrice','resumeReady','resumeVerified'].includes(mode)){const x=listing(current);if(mode==='resumeSummary')x.summaries=[];if(mode==='resumePhotos')delete x.attributes.main_offer_image_locator;if(mode==='resumeLivePrice')x.offers=[];return json(x)}
 if(mode==='getForbidden')return json({errors:[{code:'Unauthorized',message:'secret-value'}]},403);
 if(mode==='conflict'){const x=listing();x.summaries[0].asin='B000WRONG1';return json(x)}
 if(['photoMissing','photoRejected','photoWaiting'].includes(mode)){const x=listing();if(!patches||mode==='photoWaiting')delete x.attributes.main_offer_image_locator;return json(x)}
 if(mode==='registered'||puts&&['verified','asynchronousError','summaryPending','completeFailed','changedSku','changedSkuPending'].includes(mode)){const x=listing(current);if(mode==='summaryPending')x.summaries=[];if(mode==='asynchronousError')(x.issues as any[]).push({severity:'ERROR',code:'E',message:'設定確認'});return json(x)}
 return json({errors:[{code:'NOT_FOUND'}]},404);
 })as typeof fetch;
 const run=()=>handler(new Request('https://local',{method:'POST',headers:mode==='anonymous'?{}:{Authorization:'Bearer session'},body:JSON.stringify({action:mode.startsWith('resume')?'resume':'submit',itemId:id,requestId,expectedPrice:mode==='expectedPrice'?401:undefined,expectedSku:mode==='expectedSku'?'changed':undefined,photoIds:[mode==='foreignPhoto'?'66666666-6666-4666-8666-666666666666':photoId],workCompletedOn:mode==='invalidDate'?'2099-01-01':'2026-11-06'})}));
 const response=await run(),data=await response.json();assert(!JSON.stringify(data).includes('secret-value'),'credentials must not leak');
 if(['verified','registered','changedSku','photoMissing','resumeReady','resumeVerified'].includes(mode)){assert(response.ok,JSON.stringify(data));assert(data.verified);assert(complete===(mode==='resumeVerified'?0:1));assert(puts===(['registered','photoMissing','resumeReady','resumeVerified'].includes(mode)?0:1))}
 else if(['pending','summaryPending','photoWaiting','resumeSummary','resumePhotos','resumeLivePrice'].includes(mode)){assert(response.ok);assert(!data.verified);assert(complete===0);assert((record as Record<string,any>|null)?.state==='accepted')}
 else{assert(response.status>=400,mode+' should fail '+JSON.stringify(data));assert(complete===(mode==='completeFailed'?1:0));}
 if(mode.startsWith('resume')){assert(puts===0&&patches===0,'resume must never PUT or PATCH an Amazon listing');if(response.ok&&!data.verified)assert(data.requestId===requestId,'resume receipt identity');}
 if(mode==='photoWaiting'){const again=await run();assert(again.ok);assert(patches===1,'pending photo ingestion must not PATCH again');assert(complete===0);}
 if(mode==='photoMissing'){assert(patches===1);assert(puts===0);}
 if(mode==='timeout'){assert((record as Record<string,any>|null)?.state==='uncertain');const again=await run();assert(again.ok);assert(puts===1,'unknown writes must not be duplicated');assert(complete===0)}
 if(mode==='changedDetails'){assert(record?.state==='verified');assert(puts===0);assert(data.error.includes('一致しません'));} if(['anonymous','inactive','other','invalidPrice'].includes(mode))assert(external===0);
 if(['previewRejected','photo','invalidDate','conflict','stale','getForbidden','foreignPhoto','packingPhoto','expectedPrice','expectedSku','resumeMissing','resumeChanged'].includes(mode))assert(puts===0,'unsafe live PUT');
 }finally{globalThis.fetch=savedFetch;keys.forEach((k,i)=>saved[i]===undefined?Deno.env.delete(k):Deno.env.set(k,saved[i]!))}
});


Deno.test('offer photo order uses SKU image slots and ignores expiring signatures for comparisons',()=>{const images=offerImages(['https://photos.example/first.jpg?a=1','https://photos.example/second.jpg']);assert(images.main_offer_image_locator[0].media_location.includes('first'));assert(images.other_offer_image_locator_1[0].media_location.includes('second'));assert(verifiedImages({attributes:offerImages(['https://photos.example/first.jpg?a=2','https://photos.example/second.jpg'])},images));assert(!verifiedImages({attributes:offerImages(['https://photos.example/second.jpg','https://photos.example/first.jpg'])},images));});
