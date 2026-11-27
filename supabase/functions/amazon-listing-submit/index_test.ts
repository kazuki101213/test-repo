import {hasRecordedCanonicalModel,handler,listingBody,verifiedListing,offerImages,verifiedImages,listingIssueMessage,inspectReceipt,effectivePrice,receiptPricePatch,repairReceiptPrice,reconcileReceipt,observedSelfListing,validateRegisteredOffer,revalidateAsinOffer,type ListingItem} from './index.ts';
import {photographSignature,samePhotograph,verifyAmazonPhotoCopies,prepareImageDecoder,validateJpegDimensions,amazonComparisonImageUrl} from '../_shared/amazonImageVerification.ts';
import jpeg from 'npm:jpeg-js@0.4.4';

Deno.test('self-fulfilled status requires the matching Japan SKU, ASIN, condition and purchase availability',()=>{
 const receipt={sku:'fixture',asin:'B012345678',item_condition:'非常に良い'};
 const summary={marketplaceId:'A1VC38T7YXB528',asin:receipt.asin,conditionType:'used_very_good',status:['BUYABLE']};
 const listing={sku:receipt.sku,summaries:[summary],fulfillmentAvailability:[{fulfillmentChannelCode:'DEFAULT',quantity:1}]};
 if(!observedSelfListing(listing,receipt))throw new Error('BUYABLE self-fulfilled listing did not match');
 for(const mismatch of [
  null,
  {...listing,sku:'other'},
  {...listing,summaries:[{...summary,asin:'other'}]},
  {...listing,summaries:[{...summary,conditionType:'used_good'}]},
  {...listing,summaries:[{...summary,marketplaceId:'elsewhere'}]},
  {...listing,summaries:[{...summary,status:['DISCOVERABLE']}]},
  {...listing,fulfillmentAvailability:[{fulfillmentChannelCode:'DEFAULT',quantity:0}]},
  {...listing,fulfillmentAvailability:[{fulfillmentChannelCode:'AMAZON_JP',quantity:1}]},
 ])if(observedSelfListing(mismatch,receipt))throw new Error('Ambiguous or unavailable listing matched');
});
const assert=(v:unknown,m='assertion failed')=>{if(!v)throw Error(m)};
const id='11111111-1111-4111-8111-111111111111',requestId='22222222-2222-4222-8222-222222222222',market='A1VC38T7YXB528';
const item=():ListingItem=>({id,sku:'100000-AAAA-20261106-35',asin:'B015INS3IE',condition:'非常に良い',description:'説明\\n本文',planned_price:400,sales_channel:'FBA2',status:'商品登録前',is_accessory:false,deliverer_id:'staff',purchased_at:'2026-10-01'});
const photoId='55555555-5555-4555-8555-555555555555',photoUrl='https://test.supabase.co/storage/v1/object/sign/item-photos/photo.jpg?token=test';
const listing=(i=item())=>({sku:i.sku,summaries:[{marketplaceId:market,productType:'HVAC_AIR_FILTER',asin:i.asin,conditionType:'used_very_good'}],offers:[{marketplaceId:market,offerType:'B2C',price:{currencyCode:'JPY',amount:i.planned_price}}],attributes:{...listingBody(i).attributes,...offerImages([photoUrl])},issues:[]});
Deno.test('Amazon recompressed and resized photographs verify by content, including legacy submitted order',async()=>{
 await prepareImageDecoder();
 const raster=(size:number,reverse=false)=>{const data=new Uint8Array(size*size*4);for(let y=0;y<size;y++)for(let x=0;x<size;x++){const k=(y*size+x)*4;data[k]=reverse?20:210;data[k+1]=x<size/2?40:150;data[k+2]=y<size/2?220:20;data[k+3]=255;}return{data,width:size,height:size};};
 const one=raster(192),two=raster(192,true);assert(!samePhotograph(photographSignature(one),photographSignature(two)));
 const bytes=new Map([['https://approved.example/a.jpg',jpeg.encode(one,95).data],['https://approved.example/b.jpg',jpeg.encode(two,95).data],['https://m.media-amazon.com/a.jpg',jpeg.encode(raster(96),50).data],['https://m.media-amazon.com/b.jpg',jpeg.encode(raster(96,true),50).data]]);
 const saved=globalThis.fetch;try{globalThis.fetch=(async(input:RequestInfo|URL)=>{const data=bytes.get(String(input));assert(data,'unexpected image request');return new Response(data as any,{headers:{'content-length':String(data!.length)}})})as typeof fetch;
  const images=offerImages(['https://approved.example/a.jpg','https://approved.example/b.jpg']),remote={attributes:{main_product_image_locator:[{marketplace_id:market,media_location:'https://m.media-amazon.com/b.jpg'}],other_product_image_locator_1:[{marketplace_id:market,media_location:'https://m.media-amazon.com/a.jpg'}]}};
  assert(!(await verifyAmazonPhotoCopies(remote,images)).verified);const result=await verifyAmazonPhotoCopies(remote,images,true);assert(result.verified&&result.order.join(',')==='1,0');
  remote.attributes.main_product_image_locator[0].media_location='https://untrusted.example/private';assert(!(await verifyAmazonPhotoCopies(remote,images,true)).verified);
 }finally{globalThis.fetch=saved;}
});
for(const mode of['alias','foreignAlias','missingRead','recover','recoverTimeout','concurrentRecovery','staleRecovery','changedPrice','noApproval','wrongSeller','foreignPhoto','failedReceipt','completeFailure','photoRepair','photoRepairTimeout','photoReadOnly','photoEarly','FBA','FBA1','FBA2'])Deno.test('durable reconciliation '+mode,async()=>{
 const current={...item(),sales_channel:mode.startsWith('FBA')?mode:'自己発送2'},r:any={request_id:requestId,item_id:id,requested_by:'fixture-user',sku:current.sku,asin:current.asin,price:400,item_condition:current.condition,sales_channel:current.sales_channel,description:current.description,work_completed_on:'2026-11-06',created_at:new Date(Date.now()-1200000).toISOString(),state:mode==='failedReceipt'?'failed':'accepted',seller_id:mode==='FBA'||mode==='FBA1'?'A1WI3OGPE43N2T':'A3E7BXJWH9TP11',photo_ids:mode==='foreignPhoto'?['66666666-6666-4666-8666-666666666666']:[photoId],recovery_count:0};
 if(mode==='alias'||mode==='foreignAlias')current.sku='100000-AAAA-20261106-34';if(mode==='changedPrice')current.planned_price=500;
 let puts=0,previews=0,reads=0,completes=0,itemReads=0,photoPatches=0;
 const remote=listing({...current,sku:r.sku,planned_price:400});
 if(mode.startsWith('photo')){delete remote.attributes.main_offer_image_locator;r.photo_submitted_at=new Date(Date.now()-(mode==='photoEarly'?0:1200000)).toISOString();}
 const api={sellerId:mode==='wrongSeller'?'wrong':r.seller_id,get:async(sku:string)=>{reads++;assert(sku===r.sku);return ['missingRead','recover','recoverTimeout','concurrentRecovery','staleRecovery'].includes(mode)&&!puts?null:mode==='recoverTimeout'?null:remote;},catalog:async()=>({asin:r.asin}),patchImages:async(sku:string,images:any,_remote:any,preview=false)=>{assert(sku===r.sku&&images.main_offer_image_locator);if(preview)return{status:'VALID'};assert(r.photo_submission_id?.startsWith('pending:'));photoPatches++;if(mode==='photoRepairTimeout')throw Error('timeout');Object.assign(remote.attributes,images);return{status:'ACCEPTED',submissionId:'photos-only'};},put:async(sku:string,body:any,preview=false)=>{assert(sku===r.sku);assert(body.attributes.purchasable_offer[0].our_price[0].schedule[0].value_with_tax===400);if(preview){previews++;return{status:'VALID'}}assert(r.recovery_count===1,'reserve recovery before PUT');puts++;if(mode==='recoverTimeout')throw Error('timeout');return{status:'ACCEPTED',submissionId:'same-sku-recovery'};}};
 const svc:any={rpc:async(name:string)=>{if(name==='listing_photos_approved')return{data:mode!=='noApproval'};assert(name==='complete_verified_amazon_listing');completes++;assert(r.state==='verified'&&r.photos_verified_at);return mode==='completeFailure'?{error:{message:'db failed'}}:{};},storage:{from:()=>({createSignedUrls:async()=>({data:[{signedUrl:photoUrl}]})})},from(table:string){let update:any=null,where:any={};const q:any={select(){return q},eq(key:string,value:unknown){where[key]=value;return q},in(){return q},is(){return q},order(){return q},update(value:any){update=value;return q},maybeSingle:async()=>{if(update){if(mode==='concurrentRecovery'&&'recovery_count'in update)return{data:null};Object.assign(r,update);return{data:{request_id:requestId}};}if(table==='item_sku_aliases')return{data:{item_id:mode==='foreignAlias'?'someone-else':id}};return{data:r}},single:async()=>{itemReads++;return{data:{...current,...(mode==='staleRecovery'&&itemReads>1?{planned_price:500}:{})}}},then(resolve:any){if(table==='item_photos')return Promise.resolve({data:[{id:photoId,storage_path:'photo.jpg'}]}).then(resolve);if(update)Object.assign(r,update);return Promise.resolve({}).then(resolve)}};return q;}};
 const input={itemId:id,requestId,expectedSku:current.sku,expectedPrice:current.planned_price,recoverMissing:['recover','recoverTimeout','concurrentRecovery','staleRecovery'].includes(mode),repairPhotos:['photoRepair','photoRepairTimeout','photoEarly'].includes(mode)};
 let result:any;try{result=await reconcileReceipt(svc,input,async()=>api as any);}catch{assert(['foreignAlias','recoverTimeout','staleRecovery','changedPrice','noApproval','wrongSeller','foreignPhoto','failedReceipt','completeFailure','photoRepairTimeout'].includes(mode),'unexpected reconciliation failure '+mode);}
 if(mode==='alias'){assert(result.verified&&puts===0&&completes===1);assert(current.sku.endsWith('-34'),'preserve generated inventory SKU');assert(r.sku.endsWith('-35'),'keep registered Amazon SKU');}
 if(mode.startsWith('FBA')){assert(result.verified&&r.state==='verified'&&r.photos_verified_at);assert(completes===0&&puts===0&&photoPatches===0,'FBA registration must not complete inbound work or resubmit');assert(current.status==='商品登録前');assert(result.note.includes('FBA納品手続き'));}
 if(mode==='missingRead')assert(result.state==='retryable'&&puts===0&&previews===0);
 if(mode==='recover')assert(result.verified&&puts===1&&r.recovery_submission_id==='same-sku-recovery'&&completes===1);
 if(mode==='recoverTimeout'){await reconcileReceipt(svc,input,async()=>api as any);assert(puts===1&&r.recovery_count===1,'unknown result must not replay');}
 if(mode==='photoRepair'){assert(!result.verified&&photoPatches===1&&r.photo_submission_id==='photos-only');const next=await reconcileReceipt(svc,{...input,repairPhotos:false},async()=>api as any);assert(next.verified&&photoPatches===1&&completes===1);}
 if(mode==='photoRepairTimeout'){await reconcileReceipt(svc,input,async()=>api as any);assert(photoPatches===1,'unknown photo PATCH must not repeat');}
 if(mode==='photoReadOnly')assert(result.state==='retryable'&&photoPatches===0);
 if(mode==='photoEarly')assert(result.state==='accepted'&&photoPatches===0);
 if(['foreignAlias','changedPrice','noApproval','failedReceipt'].includes(mode))assert(reads===0);
 if(!['recover','recoverTimeout'].includes(mode))assert(puts===0);
});
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
Deno.test('photo verification accepts normalized product locator slots only for exact submitted source and order',()=>{
 const images=offerImages(['https://photos.example/one.jpg?a=1','https://photos.example/two.jpg']);
 const remote={attributes:Object.fromEntries(Object.entries(images).map(([key,value])=>[key.replace('_offer_','_product_'),value]))};
 assert(verifiedImages(remote,images));assert(!verifiedImages(remote,offerImages(['https://photos.example/two.jpg','https://photos.example/one.jpg'])));
 assert(!verifiedImages({summaries:[{mainImage:{link:'https://photos.example/one.jpg'}}]},images));
 assert(!verifiedImages(remote,offerImages(['https://photos.example/one.jpg'])),'unexpected trailing photo is not the selected set');
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
Deno.test('battery inclusion defaults to false on all channels and the Japanese catalog supplies cell composition',()=>{
 for(const sales_channel of ['FBA1','FBA2','自己発送1','自己発送2']){
  const fields=listingBody({...item(),sales_channel},{attributes:{batteries_included:[{value:true,marketplace_id:'ATVPDKIKX0DER'}]}}).attributes;
  assert(fields.batteries_included.length===1&&fields.batteries_included[0].value===false);
  assert(fields.batteries_included[0].marketplace_id===market);
  assert(!('batteries_required' in fields)&&!('supplier_declared_dg_hz_regulation' in fields));
 }
 const known=listingBody(item(),{attributes:{
  batteries_included:[{value:true,marketplace_id:market}],
  battery:[{marketplace_id:'ATVPDKIKX0DER',cell_composition:[{value:'lithium_ion'}]},
    {marketplace_id:market,cell_composition:[{value:'alkaline'}],weight:[{value:20}]}],
  batteries_required:[{value:false}],supplier_declared_dg_hz_regulation:[{value:'not_applicable'}],
 }}).attributes;
 assert(known.batteries_included[0].value===false);
 assert(JSON.stringify(known.battery)===JSON.stringify([{cell_composition:[{value:'alkaline'}],marketplace_id:market}]));
 assert(known.batteries_required[0].value===false);
 assert(known.supplier_declared_dg_hz_regulation[0].value==='not_applicable');
});
Deno.test('verification checks SKU, ASIN, price, condition, channel and asynchronous issues',()=>{for(const change of ['sku','asin','price','condition','fulfillment','error']){const x=listing();if(change==='sku')x.sku='wrong';if(change==='asin')x.summaries[0].asin='B000WRONG1';if(change==='price')x.attributes.purchasable_offer[0].our_price[0].schedule[0].value_with_tax=401;if(change==='condition')x.summaries[0].conditionType='new_new';if(change==='fulfillment')x.attributes.fulfillment_availability=[{fulfillment_channel_code:'DEFAULT'}];if(change==='error')(x.issues as any[]).push({severity:'ERROR',code:'123',message:'missing data'});assert(!verifiedListing(x,item()),change)}assert(verifiedListing(listing(),item()))});
for(const mode of ['anonymous','inactive','other','photo','invalidPrice','invalidDate','wrongSeller','previewRejected','getForbidden','conflict','pending','timeout','putRejected','asynchronousError','summaryPending','registered','verified','stale','completeFailed','changedSku','changedSkuPending','changedDetails','photoMissing','photoRejected','photoWaiting','foreignPhoto','packingPhoto','expectedPrice','expectedSku','resumeSummary','resumePhotos','resumeLivePrice','resumeReady','resumeMissing','resumeChanged','resumeVerified'])Deno.test(mode,async()=>{
 const savedFetch=globalThis.fetch,keys=['SUPABASE_URL','SUPABASE_ANON_KEY','SUPABASE_SERVICE_ROLE_KEY',...['AMAZON_','AMAZON_2_'].flatMap(p=>['LWA_CLIENT_ID','LWA_CLIENT_SECRET','LWA_REFRESH_TOKEN','SELLER_ID'].map(k=>p+k))],saved=keys.map(k=>Deno.env.get(k));
 let patches=0,preview=0,puts=0,complete=0,record:Record<string,any>|null=null,itemReads=0,external=0;const current=item();if(mode==='resumeLivePrice'||mode==='completeFailed')current.sales_channel='自己発送2';if(mode==='changedSku'||mode==='changedSkuPending'||mode==='changedDetails'){record={request_id:'33333333-3333-4333-8333-333333333333',item_id:id,sku:current.sku,asin:current.asin,sales_channel:current.sales_channel,account_id:'amazon-2',seller_id:'A3E7BXJWH9TP11',price:current.planned_price,item_condition:current.condition,description:current.description,work_completed_on:'2026-11-06',state:'accepted'};if(mode==='changedDetails')current.condition='良い';else{current.sku='100001-AAAA-20261106-35';current.sales_channel='自己発送2';}}if(mode==='invalidPrice')current.planned_price=0;if(mode.startsWith('resume')&&mode!=='resumeMissing'){record={request_id:requestId,item_id:id,sku:current.sku,asin:current.asin,sales_channel:current.sales_channel,account_id:'amazon-2',seller_id:'A3E7BXJWH9TP11',price:current.planned_price,item_condition:current.condition,description:current.description,work_completed_on:'2026-11-06',state:mode==='resumeVerified'?'verified':'accepted'};if(mode==='resumeChanged')current.planned_price=500;if(mode==='resumeVerified')current.status='出品中';}
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
  if(method==='PATCH'){assert(new Headers(init?.headers).get('authorization')==='Bearer service');Object.assign(record!,JSON.parse(String(init?.body)));return json(url.includes('select=request_id')?{request_id:record!.request_id}:null)}
  if(url.includes('request_id=eq.'))return json(record&&decodeURIComponent(url).includes('request_id=eq.'+record.request_id)?record:null);
  return json(record&&['submitting','accepted','uncertain'].includes(record.state)?[record]:[]);
 }
 if(url.includes('/rpc/complete_verified_amazon_listing')){if(mode==='changedSku')assert(JSON.parse(String(init?.body)).p_request_id===requestId,'old SKU proof must not complete current SKU');complete++;assert((record as Record<string,any>|null)?.state==='verified','never complete before verification');return mode==='completeFailed'?json({message:'failure',code:'42501'},403):json(null)}
 if(url.includes('/auth/o2/token'))return json({access_token:'test-token'});
 if(url.includes('/catalog/2022-04-01/items/'))return json({asin:current.asin,attributes:{batteries_required:[{value:false,marketplace_id:market}],supplier_declared_dg_hz_regulation:[{value:'not_applicable',marketplace_id:market}]}});
 external++;if((mode==='changedSku'||mode==='changedSkuPending'||mode==='changedDetails')&&url.includes(encodeURIComponent(item().sku)+'?')){const previous=listing(item());if(mode==='changedSkuPending')previous.summaries=[];return json(previous);}
 assert(url.includes('/items/A3E7BXJWH9TP11/'),'must use Amazon2');
 if(method==='PATCH'){const data=JSON.parse(String(init?.body));assert(data.productType==='HVAC_AIR_FILTER','photo patches use the actual SKU product type');assert(data.patches.every((p:any)=>/^\/attributes\/(main|other)_offer_image_locator/.test(p.path)),'patch photos only');if(url.includes('VALIDATION_PREVIEW'))return json({status:'VALID'});patches++;return json(mode==='photoRejected'?{status:'INVALID',issues:[{severity:'ERROR',code:'IMAGE',message:'写真確認'}]}:{status:'ACCEPTED'});}
 if(method==='PUT'){
  const submitted=JSON.parse(String(init?.body));
  assert(submitted.attributes.batteries_included[0].value===false,'battery inclusion must be sent in both the preview and live PUT');
  assert(submitted.attributes.batteries_included[0].marketplace_id===market);
  if(url.includes('VALIDATION_PREVIEW')){preview++;return json(mode==='previewRejected'?{status:'INVALID',issues:[{severity:'ERROR',code:'8541',message:'ASIN確認'}]}:{status:'VALID',issues:[]})}
  assert(submitted.attributes.batteries_required[0].value===false);assert(submitted.attributes.supplier_declared_dg_hz_regulation[0].value==='not_applicable');
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
 if(['verified','registered','resumeReady','resumeVerified'].includes(mode)){assert(response.ok,JSON.stringify(data));assert(data.verified);assert(complete===(current.sales_channel?.startsWith('FBA')?0:1));if(current.sales_channel?.startsWith('FBA'))assert(data.note.includes('FBA納品手続き'));assert(puts===(['registered','photoMissing','resumeReady','resumeVerified'].includes(mode)?0:1))}
 else if(['pending','summaryPending','photoMissing','photoWaiting','resumeSummary','resumePhotos','resumeLivePrice'].includes(mode)){assert(response.ok);assert(!data.verified);assert(complete===0);assert((record as Record<string,any>|null)?.state==='accepted')}
 else{assert(response.status>=400,mode+' should fail '+JSON.stringify(data));assert(complete===(mode==='completeFailed'?1:0));}
 if(mode.startsWith('resume')){assert(puts===0&&patches===0,'resume must never PUT or PATCH an Amazon listing');if(response.ok&&!data.verified)assert(data.requestId===requestId,'resume receipt identity');}
 if(mode==='photoWaiting'){const again=await run();assert(again.ok);assert(patches===1,'pending photo ingestion must not PATCH again');assert(complete===0);}
 if(mode==='photoMissing'){assert(patches===1);assert(puts===0);const again=await run();assert(again.ok);assert((await again.json()).verified);assert(patches===1);assert(complete===(current.sales_channel?.startsWith('FBA')?0:1));}
 if(mode==='timeout'){assert((record as Record<string,any>|null)?.state==='uncertain');const again=await run();assert(again.ok);assert(puts===1,'unknown writes must not be duplicated');assert(complete===0)}
 if(mode==='changedDetails'||mode==='changedSku'){assert(record?.state==='accepted');assert(puts===0);assert(data.error.includes('変更'));} if(['anonymous','inactive','other','invalidPrice'].includes(mode))assert(external===0);
 if(['previewRejected','photo','invalidDate','conflict','stale','getForbidden','foreignPhoto','packingPhoto','expectedPrice','expectedSku','resumeMissing','resumeChanged'].includes(mode))assert(puts===0,'unsafe live PUT');
 }finally{globalThis.fetch=savedFetch;keys.forEach((k,i)=>saved[i]===undefined?Deno.env.delete(k):Deno.env.set(k,saved[i]!))}
});


Deno.test('offer photo order uses SKU image slots and ignores expiring signatures for comparisons',()=>{const images=offerImages(['https://photos.example/first.jpg?a=1','https://photos.example/second.jpg']);assert(images.main_offer_image_locator[0].media_location.includes('first'));assert(images.other_offer_image_locator_1[0].media_location.includes('second'));assert(verifiedImages({attributes:offerImages(['https://photos.example/first.jpg?a=2','https://photos.example/second.jpg'])},images));assert(!verifiedImages({attributes:offerImages(['https://photos.example/second.jpg','https://photos.example/first.jpg'])},images));});

Deno.test('Amazon catalog markup issue identifies the attribute without recommending a resubmission',()=>{
 const report={severity:'ERROR',code:'100339',message:'noncompliant markup',attributeNames:['product_accolade']};
 const body=listingBody(item());
 assert(!('product_accolade' in body.attributes),'Offer payload must not contribute accolades');
 const remote={issues:[report],attributes:body.attributes};
 const message=listingIssueMessage(remote,'B07WZK3RJR');
 assert(message.includes('product_accolade')&&message.includes('B07WZK3RJR')&&!message.includes('再送'));
 const offerIssue={...remote,issues:[{...report,attributeNames:['condition_note']}]};
 assert(listingIssueMessage(offerIssue,'B07WZK3RJR')==='100339：noncompliant markup');
 const existingContribution={...remote,attributes:{...body.attributes,product_accolade:[{value:'old'}]}};
 assert(listingIssueMessage(existingContribution,'B07WZK3RJR')==='100339：noncompliant markup');
});


Deno.test('catalog-only variation and model errors need a valid offer preview and do not change catalog attributes',async()=>{
 for(const [code,name] of [['90244','variation_theme'],['100095','model_name'],['100095','customer_package_type'],['100339','product_accolade']]){
  const original:any={...listing(),issues:[{code,severity:'ERROR',attributeNames:[name],message:'catalog metadata'}]};
  original.summaries[0].status=['DISCOVERABLE'];
  const before=JSON.stringify(original);
  let previews=0;
  const result=await validateRegisteredOffer(original,item(),{put:async(sku,body,preview)=>{
   assert(preview===true&&sku===item().sku,'only validate the existing SKU');
   assert(body.requirements==='LISTING_OFFER_ONLY');
   assert(!Object.hasOwn(body.attributes,name),'do not invent product metadata');
   assert(body.attributes.purchasable_offer[0].our_price[0].schedule[0].value_with_tax===400);
   previews++;return{status:'VALID',sku};
  }});
  assert(previews===1&&result&&verifiedListing(result,item()));
  assert(JSON.stringify(original)===before,'keep original errors for diagnostics');
  assert(await validateRegisteredOffer(result,item(),{put:async()=>{throw Error('no second preview needed')}})===result);
 }
});
Deno.test('offer validation preserves real, attributed, mixed and enforced errors',async()=>{
 for(const variant of ['ownAttribute','otherField','packageOtherCode','ownPackage','otherCode','ownAccolade','otherError','enforced','unrecognizedEnforcement','wrongAsin','wrongPrice','noStatus','previewInvalid','previewError','previewSku','previewMissing']){
  const i=item();
  const remote:any={...listing(),issues:[{code:'90244',severity:'ERROR',attributeNames:['variation_theme']}]};
  remote.summaries[0].status=['DISCOVERABLE'];
  if(variant==='ownAttribute')remote.attributes.variation_theme=[{name:'INVALID'}];
  if(variant==='otherField')remote.issues[0].attributeNames=['model_number'];
  if(variant==='packageOtherCode')remote.issues[0].attributeNames=['customer_package_type'];
  if(variant==='ownPackage'){remote.issues[0]={code:'100095',severity:'ERROR',attributeNames:['customer_package_type']};remote.attributes.customer_package_type=[{value:'常规包装'}];}
  if(variant==='otherCode')remote.issues[0].code='100339';
  if(variant==='ownAccolade'){remote.issues[0]={code:'100339',severity:'ERROR',attributeNames:['product_accolade']};remote.attributes.product_accolade=[{value:'own'}];}
  if(variant==='otherError')remote.issues.push({code:'90220',severity:'ERROR',attributeNames:['batteries_included']});
  if(variant==='enforced')remote.issues[0].enforcements={actions:[{action:'LISTING_SUPPRESSED'}]};
  if(variant==='unrecognizedEnforcement')remote.issues[0].enforcements={};
  if(variant==='wrongAsin')remote.summaries[0].asin='B000000000';
  if(variant==='wrongPrice')remote.offers[0].price.amount=100;
  if(variant==='noStatus')delete remote.summaries[0].status;
  let previews=0;
  const result=await validateRegisteredOffer(remote,i,{put:async()=>{
   previews++;
   if(variant==='previewInvalid')return{status:'INVALID'};
   if(variant==='previewError')return{status:'VALID',issues:[{severity:'ERROR',code:'90220'}]};
   if(variant==='previewSku')return{status:'VALID',sku:'other'};
   if(variant==='previewMissing')return null;
   throw Error('must not validate a non-catalog error');
  }});
  assert(result===remote,'keep blocking error for '+variant);
  assert(previews===(variant.startsWith('preview')?1:0),'preview guard '+variant);
 }
});

Deno.test('2474 and 2489: pre-inbound FBA can validate an inherited model error without a live price',async()=>{
 const i={...item(),sales_channel:'FBA2'};
 const remote:any={...listing(),offers:[],fulfillmentAvailability:[],issues:[{code:'100095',severity:'ERROR',attributeNames:['model_name']}]};
 remote.attributes=listingBody(i).attributes;
 remote.summaries[0].status=['DISCOVERABLE'];
 const before=JSON.stringify(remote);let previews=0;
 const result=await validateRegisteredOffer(remote,i,{put:async(sku,body,preview)=>{
  assert(preview===true&&sku===i.sku);
  assert(body.attributes.purchasable_offer[0].our_price[0].schedule[0].value_with_tax===i.planned_price);
  assert(!Object.hasOwn(body.attributes,'model_name'));
  previews++;return{status:'VALID',sku};
 }});
 assert(previews===1&&!!result&&verifiedListing(result,i));
 assert(JSON.stringify(remote)===before);
});
Deno.test('A missing FBA live price never excuses active stock, FBM, uncertain offers, wrong submitted price or enforcement',async()=>{
 for(const variant of ['buyable','stock','fbm','missingOffers','submittedPrice','enforced']){
  const i={...item(),sales_channel:'FBA2'};
  const remote:any={...listing(),offers:[],fulfillmentAvailability:[],issues:[{code:'100095',severity:'ERROR',attributeNames:['model_name']}]};
  remote.attributes=listingBody(i).attributes;remote.summaries[0].status=['DISCOVERABLE'];
  if(variant==='buyable')remote.summaries[0].status.push('BUYABLE');
  if(variant==='stock')remote.fulfillmentAvailability=[{fulfillmentChannelCode:'AMAZON_JP',quantity:1}];
  if(variant==='fbm')i.sales_channel='自己発送2';
  if(variant==='missingOffers')delete remote.offers;
  if(variant==='submittedPrice')remote.attributes.purchasable_offer[0].our_price[0].schedule[0].value_with_tax=1;
  if(variant==='enforced')remote.issues[0].enforcements={actions:[{action:'LISTING_SUPPRESSED'}]};
  let calls=0;
  const result=await validateRegisteredOffer(remote,i,{put:async()=>{calls++;throw Error('must not bypass real error')}});
  assert(result===remote&&calls===0,variant);
 }
});

Deno.test('Native image decoding rejects missing, truncated and oversized JPEG dimensions before allocation',()=>{
 for(const bytes of [
  new Uint8Array([1,2,3]),
  new Uint8Array([255,216,255,192,0,8,8,255,255,255,255,0]),
  new Uint8Array([255,216,255,192,0,20,8,1]),
 ]){
  let rejected=false;try{validateJpegDimensions(bytes)}catch{rejected=true}assert(rejected);
 }
 const data=new Uint8Array(64*64*4).fill(100);
 validateJpegDimensions(jpeg.encode({data,width:64,height:64},80).data);
});

Deno.test('Amazon copies use the same asset at bounded comparison resolution without changing submitted photos',()=>{
 assert(amazonComparisonImageUrl('https://m.media-amazon.com/images/I/71example._SL1500_.jpg')==='https://m.media-amazon.com/images/I/71example._SL256_.jpg');
 assert(amazonComparisonImageUrl('https://m.media-amazon.com/images/I/71example.jpg')==='https://m.media-amazon.com/images/I/71example._SL256_.jpg');
 let blocked=false;try{amazonComparisonImageUrl('https://evil.example/images/I/71example.jpg')}catch{blocked=true}assert(blocked);
});

Deno.test('Only a recorded canonical contribution can be revalidated as an offer without excusing other errors',()=>{
 const i=item(),r:any={sku:i.sku,asin:i.asin,note:'Amazon型番補正:'+JSON.stringify({state:'accepted',sku:i.sku,asin:i.asin,attribute:'model_name',value:'2B-C10BW1',submissionId:'accepted'})};
 const remote:any={...listing(i),issues:[{code:'100095',severity:'ERROR',attributeNames:['model_name']}]};
 remote.attributes.model_name=[{value:'2B-C10BW1',marketplace_id:market}];
 assert(hasRecordedCanonicalModel(remote,r,i));
 for(const variant of ['unaccepted','wrongSku','wrongValue','otherError','enforced','wrongPrice','cleared']){
  const rr=structuredClone(r),copy=structuredClone(remote);
  if(variant==='unaccepted')rr.note=rr.note.replace('"state":"accepted"','"state":"uncertain"');
  if(variant==='wrongSku')rr.sku='other';
  if(variant==='wrongValue')copy.attributes.model_name[0].value='different';
  if(variant==='otherError')copy.issues.push({code:'90220',severity:'ERROR'});
  if(variant==='enforced')copy.issues[0].enforcements={actions:[{action:'LISTING_SUPPRESSED'}]};
  if(variant==='wrongPrice')copy.attributes.purchasable_offer[0].our_price[0].schedule[0].value_with_tax=1;
  if(variant==='cleared')copy.issues=[];
  assert(!hasRecordedCanonicalModel(copy,rr,i),variant);
 }
});

Deno.test('ASIN offer revalidation checks the current schema, preserves selected photos and sales terms, and reserves a single real submission',async()=>{
 for(const variant of ['success','timeout','concurrent','restricted','invalidPreview','wrongSku','wrongPrice','wrongAsin','foreignPhoto','duplicatePhoto','unapproved','wrongSeller','buyable','stock','changedItem','unsupportedField']){
  const i=item(),remote:any=listing(i);
  remote.summaries[0].status=['DISCOVERABLE'];
  if(variant==='buyable')remote.summaries[0].status.push('BUYABLE');
  if(variant==='stock')remote.fulfillmentAvailability=[{quantity:1}];
  const r:any={request_id:requestId,item_id:id,state:'accepted',sku:i.sku,asin:i.asin,price:i.planned_price,item_condition:i.condition,sales_channel:i.sales_channel,description:i.description,seller_id:'seller',photo_ids:[photoId],note:'waiting'};
  if(variant==='wrongAsin')r.asin='B000000000';
  if(variant==='foreignPhoto')r.photo_ids=['foreign'];
  if(variant==='duplicatePhoto')r.photo_ids=[photoId,photoId];
  let reads=0,writes=0,previews=0;
  const svc:any={rpc:async()=>({data:variant!=='unapproved'}),storage:{from:()=>({createSignedUrls:async(paths:string[])=>{assert(paths.join(',')==='photo.jpg');return{data:[{signedUrl:photoUrl}]};}})},from(table:string){let update:any,filters:any={};const q:any={select(){return q},eq(k:string,v:any){filters[k]=v;return q},is(k:string,v:any){filters[k]=v;return q},update(v:any){update=v;return q},single:async()=>{reads++;return{data:{...i,planned_price:variant==='changedItem'&&reads>1?1:i.planned_price}}},maybeSingle:async()=>{if(!update)return{data:r};if(variant==='concurrent'||filters.note!==r.note)return{data:null};Object.assign(r,update);return{data:{request_id:requestId}}},then(resolve:any){if(table==='item_photos')return Promise.resolve({data:[{id:photoId,storage_path:'photo.jpg'}]}).then(resolve);if(update&&filters.note===r.note)Object.assign(r,update);return Promise.resolve({}).then(resolve)}};return q;}};
  const api:any={sellerId:variant==='wrongSeller'?'other':'seller',get:async()=>remote,offerPlan:async()=>({restrictions:variant==='restricted'?[{reason:'approval'}]:[],productType:'PRODUCT',requirements:'LISTING_OFFER_ONLY',rootProperties:variant==='unsupportedField'?[]:Object.keys({...listingBody(i).attributes,...offerImages([photoUrl])})}),put:async(sku:string,payload:any,preview:boolean)=>{
   assert(sku===i.sku&&payload.productType==='PRODUCT'&&payload.requirements==='LISTING_OFFER_ONLY');
   assert(payload.attributes.merchant_suggested_asin[0].value===i.asin&&payload.attributes.purchasable_offer[0].our_price[0].schedule[0].value_with_tax===i.planned_price);
   assert(payload.attributes.fulfillment_availability[0].fulfillment_channel_code==='AMAZON_JP');
   assert(payload.attributes.main_offer_image_locator[0].media_location===photoUrl&&!('model_name'in payload.attributes)&&!('variation_theme'in payload.attributes));
   if(preview){previews++;return{status:variant==='invalidPreview'?'INVALID':'VALID',sku};}
   assert(r.note.startsWith('AmazonASIN再検証:'));writes++;if(variant==='timeout')throw Error('timeout');return{status:'ACCEPTED',submissionId:'asin-only'};
  }};
  const input={action:'revalidate-asin-offer',itemId:id,requestId,expectedSku:variant==='wrongSku'?'changed':i.sku,expectedPrice:variant==='wrongPrice'?1:i.planned_price};
  let result:any;try{result=await revalidateAsinOffer(svc,input,async()=>api);}catch{assert(!['success','concurrent'].includes(variant),variant);}
  assert(writes===(['success','timeout'].includes(variant)?1:0),variant);
  if(['success','timeout'].includes(variant)){assert(r.note.includes(variant==='success'?'accepted':'uncertain'));await revalidateAsinOffer(svc,input,async()=>api);assert(writes===1);}
  if(variant==='success')assert(result.written&&result.photoCount===1);
 }
});
Deno.test('A known model contribution is read-only and needs a fresh valid ASIN-offer preview; unknown or enforced catalog errors stay blocked',async()=>{
 const i=item(),r={sku:i.sku,asin:i.asin,note:'Amazon型番補正:'+JSON.stringify({state:'accepted',sku:i.sku,asin:i.asin,attribute:'model_name',value:'2B-C10BW1',submissionId:'accepted'})};
 for(const variant of ['valid','invalid','enforced','unrecorded','wrongValue']){
  const remote:any=listing(i);remote.summaries[0].status=['DISCOVERABLE'];remote.issues=[{code:'100095',severity:'ERROR',attributeNames:['model_name']}];
  remote.attributes.model_name=[{value:variant==='wrongValue'?'wrong':'2B-C10BW1',marketplace_id:market}];
  if(variant==='enforced')remote.issues[0].enforcements={actions:[{action:'LISTING_SUPPRESSED'}]};
  let previews=0;const before=JSON.stringify(remote);
  const result=await validateRegisteredOffer(remote,i,{put:async(sku,body,preview)=>{assert(preview===true&&body.requirements==='LISTING_OFFER_ONLY'&&!('model_name'in body.attributes));previews++;return{sku,status:variant==='invalid'?'INVALID':'VALID'};}},variant==='unrecorded'?undefined:r);
  assert(JSON.stringify(remote)===before);
  assert((!!result&&verifiedListing(result,i))===(variant==='valid'),variant);
  assert(previews===(['valid','invalid'].includes(variant)?1:0),variant);
 }
});

Deno.test('Inspection compares the receipt-selected photos in their saved order rather than the first six uploaded files',async()=>{
 const i=item(),photos=Array.from({length:8},(_,n)=>({id:'p'+n,storage_path:'photo'+n+'.jpg'})),ids=['p0','p2','p1','p3','p4','p6'];
 const r={item_id:id,request_id:requestId,state:'accepted',sku:i.sku,asin:i.asin,price:i.planned_price,item_condition:i.condition,sales_channel:i.sales_channel,seller_id:'seller',photo_ids:ids};
 const svc:any={from(table:string){const q:any={select(){return q},eq(){return q},order(){return q},maybeSingle:async()=>({data:r}),single:async()=>({data:i}),then(resolve:any){return Promise.resolve({data:photos}).then(resolve)}};return q;},storage:{from:()=>({createSignedUrls:async(paths:string[])=>{assert(paths.join(',')==='photo0.jpg,photo2.jpg,photo1.jpg,photo3.jpg,photo4.jpg,photo6.jpg');return{data:paths.map(path=>({signedUrl:'https://test.supabase.co/'+path}))};}})}};
 const result=await inspectReceipt(svc,{action:'inspect-receipt',itemId:id,requestId,includePhotos:true},async()=>({sellerId:'seller',get:async()=>listing(i)})as any);
 assert(result.photoEvidence?.photoIds.join(',')===ids.join(','));
});

Deno.test('A recorded model correction cannot deadlock FBA registration when a fresh ASIN offer and its selected photos are verified',async()=>{
 const i=item(),remote:any=listing(i);
 remote.summaries[0].status=['DISCOVERABLE'];remote.issues=[{code:'100095',severity:'ERROR',attributeNames:['model_name']}];
 remote.attributes.model_name=[{value:'2B-C10BW1',marketplace_id:market}];
 const r:any={request_id:requestId,item_id:id,state:'accepted',sku:i.sku,asin:i.asin,price:i.planned_price,item_condition:i.condition,sales_channel:i.sales_channel,description:i.description,seller_id:'seller',photo_ids:[photoId],note:'Amazon型番補正:'+JSON.stringify({state:'accepted',sku:i.sku,asin:i.asin,attribute:'model_name',value:'2B-C10BW1',submissionId:'model-only'})};
 let previews=0;
 const svc:any={rpc:async(name:string)=>{assert(name==='listing_photos_approved');return{data:true};},storage:{from:()=>({createSignedUrls:async()=>({data:[{signedUrl:photoUrl}]})})},from(table:string){let update:any;const q:any={select(){return q},eq(){return q},in(){return q},order(){return q},update(value:any){update=value;return q},maybeSingle:async()=>({data:r}),single:async()=>({data:i}),then(resolve:any){if(update)Object.assign(r,update);return Promise.resolve(table==='item_photos'?{data:[{id:photoId,storage_path:'photo.jpg'}]}:{}).then(resolve)}};return q;}};
 const result=await reconcileReceipt(svc,{itemId:id,requestId,expectedSku:i.sku,expectedPrice:i.planned_price},async()=>({sellerId:'seller',get:async()=>remote,put:async(sku:string,payload:any,preview:boolean)=>{assert(preview===true&&payload.requirements==='LISTING_OFFER_ONLY'&&!('model_name'in payload.attributes));previews++;return{status:'VALID',sku};},catalog:async()=>{throw Error('must not repair catalog facts')}})as any);
 assert(result.verified&&r.state==='verified'&&!!r.photos_verified_at&&previews===1);
});

Deno.test('The completion timestamp is written once and returned unchanged on subsequent registration checks',async()=>{
 for(const existing of [null,'2026-11-01T00:00:00.000Z']){
  const i=item(),r:any={request_id:requestId,item_id:id,state:existing?'verified':'accepted',verified_at:existing,sku:i.sku,asin:i.asin,price:i.planned_price,item_condition:i.condition,sales_channel:i.sales_channel,description:i.description,seller_id:'seller',photo_ids:[photoId]};
  const updates:any[]=[];
  const svc:any={rpc:async()=>({data:true}),storage:{from:()=>({createSignedUrls:async()=>({data:[{signedUrl:photoUrl}]})})},from(table:string){let update:any;const q:any={select(){return q},eq(){return q},in(){return q},order(){return q},update(value:any){update=value;updates.push(value);return q},maybeSingle:async()=>({data:r}),single:async()=>({data:i}),then(resolve:any){if(update)Object.assign(r,update);return Promise.resolve(table==='item_photos'?{data:[{id:photoId,storage_path:'photo.jpg'}]}:{}).then(resolve)}};return q;}};
  const connect=async()=>({sellerId:'seller',get:async()=>listing(i)})as any;
  const input={itemId:id,requestId,expectedSku:i.sku,expectedPrice:i.planned_price};
  const first=await reconcileReceipt(svc,input,connect),firstTime=r.verified_at;
  assert(first.verified&&'verifiedAt'in first&&first.verifiedAt===firstTime&&!!firstTime);
  if(existing)assert(!Object.hasOwn(updates[0],'verified_at')&&firstTime===existing);
  const second=await reconcileReceipt(svc,input,connect);
  assert('verifiedAt'in second&&second.verifiedAt===firstTime&&r.verified_at===firstTime&&!Object.hasOwn(updates[updates.length-1],'verified_at'));
 }
});
