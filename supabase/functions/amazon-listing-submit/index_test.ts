import {handler,listingBody,verifiedListing,offerImages,verifiedImages,type ListingItem} from './index.ts';
const assert=(v:unknown,m='assertion failed')=>{if(!v)throw Error(m)};
const id='11111111-1111-4111-8111-111111111111',requestId='22222222-2222-4222-8222-222222222222',market='A1VC38T7YXB528';
const item=():ListingItem=>({id,sku:'100000-AAAA-20261106-35',asin:'B015INS3IE',condition:'非常に良い',description:'説明\\n本文',planned_price:400,sales_channel:'FBA2',status:'商品登録前',is_accessory:false,deliverer_id:'staff',purchased_at:'2026-10-01'});
const photoId='55555555-5555-4555-8555-555555555555',photoUrl='https://test.supabase.co/storage/v1/object/sign/item-photos/photo.jpg?token=test';
const listing=(i=item())=>({sku:i.sku,summaries:[{marketplaceId:market,asin:i.asin,conditionType:'used_very_good'}],attributes:{...listingBody(i).attributes,...offerImages([photoUrl])},issues:[]});
Deno.test('offer uses selected seller/ASIN/price/condition and FBA has no invented quantity',()=>{const fba=listingBody(item());assert(fba.attributes.fulfillment_availability[0].fulfillment_channel_code==='AMAZON_JP');assert(!('quantity'in fba.attributes.fulfillment_availability[0]));assert(fba.attributes.purchasable_offer[0].our_price[0].schedule[0].value_with_tax===400);assert(fba.attributes.condition_note[0].value==='説明\n本文');const self=listingBody({...item(),sales_channel:'自己発送2'});assert(self.attributes.fulfillment_availability[0].quantity===1);assert(self.attributes.fulfillment_availability[0].fulfillment_channel_code==='DEFAULT')});
Deno.test('ASIN safety values are copied without inventing missing declarations',()=>{const empty=listingBody(item(),{attributes:{}}).attributes;assert(!('batteries_required'in empty));assert(!('supplier_declared_dg_hz_regulation'in empty));const known=listingBody(item(),{attributes:{batteries_required:[{value:false}],supplier_declared_dg_hz_regulation:[{value:'not_applicable'}]}}).attributes;assert(known.batteries_required[0].value===false);assert(known.supplier_declared_dg_hz_regulation[0].value==='not_applicable')});
Deno.test('verification checks SKU, ASIN, price, condition, channel and asynchronous issues',()=>{for(const change of ['sku','asin','price','condition','fulfillment','error']){const x=listing();if(change==='sku')x.sku='wrong';if(change==='asin')x.summaries[0].asin='B000WRONG1';if(change==='price')x.attributes.purchasable_offer[0].our_price[0].schedule[0].value_with_tax=401;if(change==='condition')x.summaries[0].conditionType='new_new';if(change==='fulfillment')x.attributes.fulfillment_availability=[{fulfillment_channel_code:'DEFAULT'}];if(change==='error')(x.issues as any[]).push({severity:'ERROR',code:'123',message:'missing data'});assert(!verifiedListing(x,item()),change)}assert(verifiedListing(listing(),item()))});
for(const mode of ['anonymous','inactive','other','photo','invalidPrice','invalidDate','wrongSeller','previewRejected','getForbidden','conflict','pending','timeout','putRejected','asynchronousError','summaryPending','registered','verified','stale','completeFailed','changedSku','changedSkuPending','changedDetails','photoMissing','photoRejected','foreignPhoto','packingPhoto'])Deno.test(mode,async()=>{
 const savedFetch=globalThis.fetch,keys=['SUPABASE_URL','SUPABASE_ANON_KEY','SUPABASE_SERVICE_ROLE_KEY',...['AMAZON_','AMAZON_2_'].flatMap(p=>['LWA_CLIENT_ID','LWA_CLIENT_SECRET','LWA_REFRESH_TOKEN','SELLER_ID'].map(k=>p+k))],saved=keys.map(k=>Deno.env.get(k));
 let patches=0,preview=0,puts=0,complete=0,record:Record<string,any>|null=null,itemReads=0,external=0;const current=item();if(mode==='changedSku'||mode==='changedSkuPending'||mode==='changedDetails'){record={request_id:'33333333-3333-4333-8333-333333333333',item_id:id,sku:current.sku,asin:current.asin,sales_channel:current.sales_channel,account_id:'amazon-2',seller_id:'A3E7BXJWH9TP11',price:current.planned_price,item_condition:current.condition,description:current.description,work_completed_on:'2026-11-06',state:'accepted'};if(mode==='changedDetails')current.condition='良い';else{current.sku='100001-AAAA-20261106-35';current.sales_channel='自己発送2';}}if(mode==='invalidPrice')current.planned_price=0;
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
 if(method==='PATCH'){const data=JSON.parse(String(init?.body));assert(data.patches.every((p:any)=>/^\/attributes\/(main|other)_offer_image_locator/.test(p.path)),'patch photos only');if(url.includes('VALIDATION_PREVIEW'))return json({status:'VALID'});patches++;return json(mode==='photoRejected'?{status:'INVALID',issues:[{severity:'ERROR',code:'IMAGE',message:'写真確認'}]}:{status:'ACCEPTED'});}
 if(method==='PUT'){
  if(url.includes('VALIDATION_PREVIEW')){preview++;return json(mode==='previewRejected'?{status:'INVALID',issues:[{severity:'ERROR',code:'8541',message:'ASIN確認'}]}:{status:'VALID',issues:[]})}
  const submitted=JSON.parse(String(init?.body));assert(submitted.attributes.batteries_required[0].value===false);assert(submitted.attributes.supplier_declared_dg_hz_regulation[0].value==='not_applicable');
  puts++;if(mode==='photoMissing'){assert(patches===1);assert(puts===0);}
 if(mode==='timeout')throw new DOMException('Timeout','TimeoutError');return json(mode==='putRejected'?{status:'INVALID',issues:[{severity:'ERROR',code:'X',message:'内容確認'}]}:{status:'ACCEPTED',submissionId:'submission-1',issues:[]});
 }
 if(mode==='getForbidden')return json({errors:[{code:'Unauthorized',message:'secret-value'}]},403);
 if(mode==='conflict'){const x=listing();x.summaries[0].asin='B000WRONG1';return json(x)}
 if(['photoMissing','photoRejected'].includes(mode)){const x=listing();if(!patches)delete x.attributes.main_offer_image_locator;return json(x)}
 if(mode==='registered'||puts&&['verified','asynchronousError','summaryPending','completeFailed','changedSku','changedSkuPending'].includes(mode)){const x=listing(current);if(mode==='summaryPending')x.summaries=[];if(mode==='asynchronousError')(x.issues as any[]).push({severity:'ERROR',code:'E',message:'設定確認'});return json(x)}
 return json({errors:[{code:'NOT_FOUND'}]},404);
 })as typeof fetch;
 const run=()=>handler(new Request('https://local',{method:'POST',headers:mode==='anonymous'?{}:{Authorization:'Bearer session'},body:JSON.stringify({action:'submit',itemId:id,requestId,photoIds:[mode==='foreignPhoto'?'66666666-6666-4666-8666-666666666666':photoId],workCompletedOn:mode==='invalidDate'?'2099-01-01':'2026-11-06'})}));
 const response=await run(),data=await response.json();assert(!JSON.stringify(data).includes('secret-value'),'credentials must not leak');
 if(['verified','registered','changedSku','photoMissing'].includes(mode)){assert(response.ok,JSON.stringify(data));assert(data.verified);assert(complete===1);assert(puts===(['registered','photoMissing'].includes(mode)?0:1))}
 else if(['pending','asynchronousError','summaryPending'].includes(mode)){assert(response.ok);assert(!data.verified);assert(complete===0);assert((record as Record<string,any>|null)?.state==='accepted')}
 else{assert(response.status>=400,mode+' should fail '+JSON.stringify(data));assert(complete===(mode==='completeFailed'?1:0));}
 if(mode==='photoMissing'){assert(patches===1);assert(puts===0);}
 if(mode==='timeout'){assert((record as Record<string,any>|null)?.state==='uncertain');const again=await run();assert(again.ok);assert(puts===1,'unknown writes must not be duplicated');assert(complete===0)}
 if(mode==='changedDetails'){assert(record?.state==='verified');assert(puts===0);assert(data.error.includes('一致しません'));} if(['anonymous','inactive','other','invalidPrice'].includes(mode))assert(external===0);
 if(['previewRejected','photo','invalidDate','conflict','stale','getForbidden','foreignPhoto','packingPhoto'].includes(mode))assert(puts===0,'unsafe live PUT');
 }finally{globalThis.fetch=savedFetch;keys.forEach((k,i)=>saved[i]===undefined?Deno.env.delete(k):Deno.env.set(k,saved[i]!))}
});


Deno.test('offer photo order uses SKU image slots and ignores expiring signatures for comparisons',()=>{const images=offerImages(['https://photos.example/first.jpg?a=1','https://photos.example/second.jpg']);assert(images.main_offer_image_locator[0].media_location.includes('first'));assert(images.other_offer_image_locator_1[0].media_location.includes('second'));assert(verifiedImages({attributes:offerImages(['https://photos.example/first.jpg?a=2','https://photos.example/second.jpg'])},images));assert(!verifiedImages({attributes:offerImages(['https://photos.example/second.jpg','https://photos.example/first.jpg'])},images));});
