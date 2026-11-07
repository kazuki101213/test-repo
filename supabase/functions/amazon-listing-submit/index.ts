import {createClient} from 'npm:@supabase/supabase-js@2.45.4';
import {amazonCredentials,AmazonAccountError,type AmazonAccountId} from '../_shared/amazonAccounts.ts';
const marketplace='A1VC38T7YXB528',endpoint='https://sellingpartnerapi-fe.amazon.com';
const headers={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type','Access-Control-Allow-Methods':'POST, OPTIONS','Content-Type':'application/json','Cache-Control':'no-store'};
class SafeError extends Error{constructor(public status:number,message:string){super(message)}}
type Obj=Record<string,any>;
export type ListingItem={id:string;sku:string;asin:string|null;condition:string|null;description:string|null;planned_price:number|null;sales_channel:string|null;status:string;is_accessory:boolean;deliverer_id:string|null;purchased_at:string|null};
const columns='id,sku,asin,condition,description,planned_price,sales_channel,status,is_accessory,deliverer_id,purchased_at';
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const conditionTypes:Record<string,string>={'ほぼ新品':'used_like_new','非常に良い':'used_very_good','良い':'used_good','可':'used_acceptable'};
export function accountFor(channel:string|null):AmazonAccountId{if(channel==='FBA2'||channel==='自己発送2')return'amazon-2';if(['FBA','FBA1','自己発送','自己発送1'].includes(channel??''))return'amazon-1';throw new SafeError(422,'Amazonの販売先を選択してください。');}
export function listingBody(item:ListingItem,catalog?:Obj|null){
 if(!item.asin||!/^[0-9A-Z]{10}$/.test(item.asin)||!conditionTypes[item.condition??'']||!Number.isSafeInteger(item.planned_price)||(item.planned_price??0)<1)throw new SafeError(422,'ASIN・コンディション・予定販売価格を確認してください。');
 const attributes:Obj={merchant_suggested_asin:[{value:item.asin,marketplace_id:marketplace}],condition_type:[{value:conditionTypes[item.condition!],marketplace_id:marketplace}],purchasable_offer:[{audience:'ALL',currency:'JPY',marketplace_id:marketplace,our_price:[{schedule:[{value_with_tax:item.planned_price}]}]}],fulfillment_availability:[/^FBA/.test(item.sales_channel??'')?{fulfillment_channel_code:'AMAZON_JP'}:{fulfillment_channel_code:'DEFAULT',quantity:1}]};
 // Use actual ASIN attributes only; never invent battery or dangerous-goods declarations.
 for(const name of ['batteries_required','supplier_declared_dg_hz_regulation']){const values=(catalog?.attributes?.[name]??[]).filter((v:Obj)=>(!v.marketplace_id||v.marketplace_id===marketplace)&&(name==='batteries_required'?typeof v.value==='boolean':typeof v.value==='string'));if(values.length)attributes[name]=values.map((v:Obj)=>({value:v.value,marketplace_id:marketplace}));}
 if(item.description?.trim())attributes.condition_note=[{value:item.description.replace(/\\n/g,'\n'),language_tag:'ja_JP',marketplace_id:marketplace}];
 return{productType:'PRODUCT',requirements:'LISTING_OFFER_ONLY',attributes};
}
function issues(data:Obj|null):string[]{return(Array.isArray(data?.issues)?data!.issues:[]).filter((v:Obj)=>v.severity==='ERROR').slice(0,5).map((v:Obj)=>{const code=/^[\w.-]{1,80}$/.test(v.code??'')?v.code:'ERROR';const message=typeof v.message==='string'&&!/token|secret|authorization|password|Bearer/i.test(v.message)?v.message.slice(0,450):'';return code+(message?'：'+message:'');});}
export function verifiedListing(listing:Obj,item:ListingItem):boolean{
 const summary=listing.summaries?.find((s:Obj)=>s.marketplaceId===marketplace);
 const attributes=listing.attributes??{},offers=(attributes.purchasable_offer??[]).filter((v:Obj)=>v.currency==='JPY'&&(!v.marketplace_id||v.marketplace_id===marketplace)&&(!v.audience||v.audience==='ALL'));
 const schedules=offers.length===1?offers[0].our_price?.[0]?.schedule:[];
 // FBA with no received stock may have no active offer yet. An in-stock FBM
 // listing must expose the effective consumer price, not just submitted attributes.
 const activePrice=/^FBA/.test(item.sales_channel??'')||effectivePrice(listing)===item.planned_price;
 return activePrice&&listing.sku===item.sku&&summary?.asin===item.asin&&summary?.conditionType===conditionTypes[item.condition??'']&&schedules?.length===1&&schedules[0].value_with_tax===item.planned_price&&!schedules[0].start_at&&!schedules[0].end_at&&(attributes.fulfillment_availability??[]).some((v:Obj)=>v.fulfillment_channel_code===(/^FBA/.test(item.sales_channel??'')?'AMAZON_JP':'DEFAULT'))&&issues(listing).length===0;
}
export function effectivePrice(listing:Obj):number|null{
 const offers=(listing.offers??[]).filter((v:Obj)=>v.marketplaceId===marketplace&&v.offerType==='B2C'&&v.price?.currencyCode==='JPY');
 return offers.length===1&&typeof offers[0].price.amount==='number'&&Number.isSafeInteger(offers[0].price.amount)&&offers[0].price.amount>0?offers[0].price.amount:null;
}
export function receiptPricePatch(listing:Obj,price:number){
 const values=structuredClone(listing.attributes?.purchasable_offer??[]),indexes=values.map((v:Obj,i:number)=>({v,i})).filter(({v}:{v:Obj})=>v.currency==='JPY'&&v.marketplace_id===marketplace&&v.audience==='ALL');
 const offer=indexes.length===1?indexes[0].v:null,schedules=offer?.our_price?.length===1?offer.our_price[0].schedule:null;
 const type=listing.summaries?.find((v:Obj)=>v.marketplaceId===marketplace)?.productType;
 if(!Number.isSafeInteger(price)||price<1||!offer||schedules?.length!==1||schedules[0].start_at||schedules[0].end_at||typeof type!=='string'||!/^[A-Z][A-Z0-9_]{0,199}$/.test(type))throw new SafeError(409,'既存SKUの通常価格を一意に確認できません。');
 schedules[0].value_with_tax=price;
 return{productType:type,patches:[{op:'replace',path:'/attributes/purchasable_offer',value:values}]};
}
export function offerImages(urls:string[]):Obj{
 if(!urls.length||urls.length>6||urls.some(url=>!url.startsWith('https://')))throw new SafeError(422,'商品写真を1〜6枚で確認してください。');
 return Object.fromEntries(urls.map((url,index)=>[index?'other_offer_image_locator_'+index:'main_offer_image_locator',[{media_location:url,marketplace_id:marketplace}]]));
}
export function verifiedImages(listing:Obj,images:Obj):boolean{
 const identity=(url:unknown)=>{try{const value=new URL(String(url));return value.origin+value.pathname;}catch{return '';}};
 return Object.entries(images).every(([name,values])=>(listing.attributes?.[name]??[]).some((v:Obj)=>v.marketplace_id===marketplace&&identity(v.media_location)===identity(values[0].media_location)))&&Array.from({length:5},(_,i)=>'other_offer_image_locator_'+(i+1)).every(name=>images[name]||!(listing.attributes?.[name]??[]).some((v:Obj)=>v.marketplace_id===marketplace));
}
export function imagePatches(images:Obj,listing:Obj){return[...Object.entries(images).map(([name,value])=>({op:'replace',path:'/attributes/'+name,value})),...Array.from({length:5},(_,i)=>'other_offer_image_locator_'+(i+1)).filter(name=>!images[name]&&(listing.attributes?.[name]??[]).some((v:Obj)=>v.marketplace_id===marketplace)).map(name=>({op:'delete',path:'/attributes/'+name,value:[{marketplace_id:marketplace}]}))];}
export function photoProductType(listing:Obj){const type=listing.summaries?.find((v:Obj)=>v.marketplaceId===marketplace)?.productType;return typeof type==='string'&&/^[A-Z][A-Z0-9_]{0,199}$/.test(type)?type:'PRODUCT';}
function imageProgress(listing:Obj|null,images:Obj){const count=Object.keys(images).filter(name=>(listing?.attributes?.[name]??[]).some((value:Obj)=>value.marketplace_id===marketplace&&value.media_location)).length;return '（写真 '+count+'/'+Object.keys(images).length+'枚を確認）';}
async function approvedImages(sb:any,svc:any,itemId:string,selected:unknown):Promise<Obj>{
 const {data:list,error:listError}=await sb.functions.invoke('delivery-photo-drive',{body:{itemId,action:'list',purpose:'product'}});
 const allowed=Array.isArray(list?.photos)?list.photos.map((p:Obj)=>p.id):[];
 const ids=selected===undefined?allowed.slice(0,6):selected;
 if(listError||!Array.isArray(ids)||!ids.length||ids.length>6||new Set(ids).size!==ids.length||ids.some((id:unknown)=>!uuid(id)||!allowed.includes(id)))throw new SafeError(409,'出品する商品写真を1〜6枚で選択してください。');
 const {data:photos,error}=await svc.from('item_photos').select('id,storage_path,photo_kind').in('id',ids);
 if(error||!photos||ids.some((id:string)=>!photos.some((p:Obj)=>p.id===id&&(p.photo_kind??'product')==='product')))throw new SafeError(503,'商品写真の保存先を確認できません。');
 const paths=ids.map((id:string)=>photos.find((p:Obj)=>p.id===id)!.storage_path);
 const {data:signed,error:signError}=await svc.storage.from('item-photos').createSignedUrls(paths,604800);
 if(signError||!signed||signed.length!==paths.length||signed.some((p:Obj)=>!p.signedUrl))throw new SafeError(503,'Amazon用の商品写真を準備できません。');
 return offerImages(signed.map((p:Obj)=>p.signedUrl));
}
function verificationNote(listing:Obj):string{
 const s=listing.summaries?.find((v:Obj)=>v.marketplaceId===marketplace),a=listing.attributes??{};
 const prices=(a.purchasable_offer??[]).flatMap((o:Obj)=>(o.our_price??[]).flatMap((p:Obj)=>(p.schedule??[]).map((v:Obj)=>v.value_with_tax))).filter((v:unknown)=>typeof v==='number'&&Number.isFinite(v));
 const price=prices.length?'¥'+prices.join(' / ¥'):'未取得',condition=Object.entries(conditionTypes).find(([,value])=>value===s?.conditionType)?.[0]??'未取得';
 const channels=(a.fulfillment_availability??[]).map((v:Obj)=>v.fulfillment_channel_code).filter((v:unknown)=>v==='AMAZON_JP'||v==='DEFAULT');
 return 'Amazonの反映を確認中です（ASIN '+(/^[A-Z0-9]{10}$/.test(s?.asin??'')?s!.asin:'未取得')+'、コンディション '+condition+'、送信価格 '+price+'、販売価格 '+(effectivePrice(listing)===null?'未反映':'¥'+effectivePrice(listing))+'、配送 '+(channels.join('/')||'未取得')+'）。再度、登録結果を確認してください。';
}
function sameItem(a:ListingItem,b:ListingItem){return['sku','asin','condition','description','planned_price','sales_channel','status'].every(k=>a[k as keyof ListingItem]===b[k as keyof ListingItem]);}
async function amazon(id:AmazonAccountId){
 const credentials=amazonCredentials(id),expected=id==='amazon-2'?'A3E7BXJWH9TP11':'A1WI3OGPE43N2T';if(credentials.sellerId!==expected)throw new SafeError(503,'販売先とAmazon出品者IDの設定が一致しません。');
 const r=await fetch('https://api.amazon.com/auth/o2/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',client_id:credentials.clientId,client_secret:credentials.clientSecret,refresh_token:credentials.refreshToken}),signal:AbortSignal.timeout(15000)});
 const token=await r.json().catch(()=>null);if(!r.ok||!token?.access_token)throw new SafeError(502,'Amazonの認証に失敗しました。');
 const path='/listings/2021-08-01/items/'+encodeURIComponent(credentials.sellerId)+'/';
 async function feedCall(path:string,body?:Obj){
  const r=await fetch(endpoint+'/feeds/2021-06-30/'+path,{method:body?'POST':'GET',headers:{'x-amz-access-token':token.access_token,'content-type':'application/json','user-agent':'BussanDelivery/1.0'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000)});
  const data=await r.json().catch(()=>null);if(!r.ok||!data)throw new SafeError(502,'Amazon価格フィードAPIの確認に失敗しました（HTTP '+r.status+'）。');return data as Obj;
 }
 function documentUrl(value:unknown){const u=new URL(String(value));if(u.protocol!=='https:'||!/(^|\.)amazonaws\.com(?:\.cn)?$/.test(u.hostname))throw new SafeError(502,'Amazonのフィード保存先を確認できません。');return u.href;}
 async function submitPriceFeed(sku:string,patch:Obj){
  const contentType='application/json; charset=UTF-8',doc=await feedCall('documents',{contentType});
  const body={header:{sellerId:credentials.sellerId,version:'2.0',issueLocale:'ja_JP'},messages:[{messageId:1,sku,operationType:'PATCH',productType:patch.productType,patches:patch.patches}]};
  const upload=await fetch(documentUrl(doc.url),{method:'PUT',headers:{'content-type':contentType},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
  if(!upload.ok)throw new SafeError(502,'価格フィードのアップロードに失敗しました。');
  const result=await feedCall('feeds',{feedType:'JSON_LISTINGS_FEED',marketplaceIds:[marketplace],inputFeedDocumentId:doc.feedDocumentId});
  if(typeof result.feedId!=='string')throw new SafeError(502,'価格フィードの受付結果を確認できません。');return{status:'ACCEPTED',feedId:result.feedId};
 }
 async function priceFeedStatus(feedId:string){
  const feed=await feedCall('feeds/'+encodeURIComponent(feedId));
  if(feed.feedType!=='JSON_LISTINGS_FEED'||feed.marketplaceIds?.length!==1||feed.marketplaceIds[0]!==marketplace)throw new SafeError(409,'価格フィードの対象が一致しません。');
  let report:Obj|undefined;
  if(feed.resultFeedDocumentId){const doc=await feedCall('documents/'+encodeURIComponent(feed.resultFeedDocumentId)),r=await fetch(documentUrl(doc.url),{signal:AbortSignal.timeout(15000)});if(!r.ok||!r.body)throw new SafeError(502,'価格フィードの処理結果を取得できません。');const stream=doc.compressionAlgorithm==='GZIP'?r.body.pipeThrough(new DecompressionStream('gzip')):r.body;const data=await new Response(stream).json();report={summary:data.summary,issues:(data.issues??[]).slice(0,10)};}
  return{feedId,processingStatus:feed.processingStatus,report};
 }
 async function diagnosePrice(sku:string,asin:string,condition:string){
  const read=async(path:string,params:URLSearchParams)=>{const r=await fetch(endpoint+path+'?'+params,{headers:{'x-amz-access-token':token.access_token,'user-agent':'BussanDelivery/1.0'},signal:AbortSignal.timeout(15000)});const data=await r.json().catch(()=>null);return{httpStatus:r.status,data};};
  const [own,offers,restrictions]=await Promise.all([read('/products/pricing/v0/price',new URLSearchParams({MarketplaceId:marketplace,ItemType:'Sku',Skus:sku})),read('/products/pricing/v0/listings/'+encodeURIComponent(sku)+'/offers',new URLSearchParams({MarketplaceId:marketplace,ItemCondition:'Used',CustomerType:'Consumer'})),read('/listings/2021-08-01/restrictions',new URLSearchParams({asin,sellerId:credentials.sellerId,marketplaceIds:marketplace,conditionType:conditionTypes[condition],reasonLocale:'ja_JP'}))]);
  return{ownPrice:{httpStatus:own.httpStatus,rows:(own.data?.payload??[]).map((v:Obj)=>({status:v.status,sku:v.SellerSKU,offers:v.Product?.Offers,errors:v.errors}))},offerStatus:{httpStatus:offers.httpStatus,status:offers.data?.payload?.status,summary:offers.data?.payload?.Summary,errors:offers.data?.errors},restrictions:{httpStatus:restrictions.httpStatus,rows:restrictions.data?.restrictions,errors:restrictions.data?.errors}};
 }
 async function call(sku:string,method:'GET'|'PUT'|'PATCH',body?:Obj,preview=false){
  const params=new URLSearchParams({marketplaceIds:marketplace,issueLocale:'ja_JP',includedData:method==='GET'?'summaries,attributes,issues,offers,fulfillmentAvailability':'issues'});if(preview)params.set('mode','VALIDATION_PREVIEW');
  const response=await fetch(endpoint+path+encodeURIComponent(sku)+'?'+params,{method,headers:{'x-amz-access-token':token.access_token,'x-amz-date':new Date().toISOString().replace(/[:-]|\.\d{3}/g,''),'Content-Type':'application/json','user-agent':'BussanDelivery/1.0 (Language=TypeScript; Platform=Supabase)'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(20000)});
  const data=await response.json().catch(()=>null);if(method==='GET'&&response.status===404)return null;
  if(!response.ok)throw new SafeError(response.status>=500?502:response.status,'Amazon登録APIがエラーになりました（HTTP '+response.status+'）。'+(issues(data).join(' ')||'アカウントの権限・状態を確認してください。'));
  if(!data||typeof data!=='object')throw new SafeError(502,'Amazonの登録結果を確認できません。');return data as Obj;
 }
 return{sellerId:credentials.sellerId,diagnosePrice,submitPriceFeed,priceFeedStatus,catalog:async(asin:string)=>{const params=new URLSearchParams({marketplaceIds:marketplace,includedData:'attributes'});const r=await fetch(endpoint+'/catalog/2022-04-01/items/'+encodeURIComponent(asin)+'?'+params,{headers:{'x-amz-access-token':token.access_token,'user-agent':'BussanDelivery/1.0'},signal:AbortSignal.timeout(15000)});if(!r.ok)throw new SafeError(502,'Amazonの商品情報を取得できません（HTTP '+r.status+'）。');return await r.json() as Obj;},get:(sku:string)=>call(sku,'GET'),inspect:(sku:string)=>call(sku,'GET'),patchPrice:(sku:string,body:Obj,preview=false)=>call(sku,'PATCH',body,preview),put:(sku:string,body:Obj,preview=false)=>call(sku,'PUT',body,preview),patchImages:(sku:string,images:Obj,listing:Obj,preview=false)=>call(sku,'PATCH',{productType:photoProductType(listing),patches:imagePatches(images,listing)},preview)};
}
// Operator read-only inspection is bound to an existing, non-cancelled receipt.
// The private project dispatcher authenticates it; normal user routes retain Auth.getUser.
export async function inspectReceipt(svc:any,input:Obj,connect=amazon){
 if(input?.action!=='inspect-receipt'||!uuid(input.itemId)||!uuid(input.requestId))throw new SafeError(400,'対象の受付履歴を指定してください。');
 const {data:receipt,error}=await svc.from('amazon_listing_submissions').select('*').eq('request_id',input.requestId).eq('item_id',input.itemId).maybeSingle();
 if(error||!receipt||!['accepted','uncertain','verified'].includes(receipt.state))throw new SafeError(404,'有効な受付履歴がありません。');
 const {data:current,error:itemError}=await svc.from('items').select(columns).eq('id',receipt.item_id).single();
 if(itemError||!current)throw new SafeError(404,'商品が見つかりません。');
 const api=await connect(accountFor(receipt.sales_channel));if(api.sellerId!==receipt.seller_id)throw new SafeError(409,'受付時の出品者が一致しません。');
 const summarize=(remote:Obj|null)=>remote?{sku:remote.sku,summaries:remote.summaries,offers:remote.offers,fulfillmentAvailability:remote.fulfillmentAvailability,attributes:Object.fromEntries(['merchant_suggested_asin','condition_type','purchasable_offer','fulfillment_availability','merchant_shipping_group'].filter(key=>remote.attributes?.[key]).map(key=>[key,remote.attributes[key]])),issues:(remote.issues??[]).map((issue:Obj)=>({code:issue.code,severity:issue.severity,message:typeof issue.message==='string'&&!/token|secret|authorization|password|Bearer/i.test(issue.message)?issue.message.slice(0,500):'',attributeNames:issue.attributeNames,enforcements:issue.enforcements})),imageAttributes:Object.keys(remote.attributes??{}).filter(key=>/offer_image_locator/.test(key)),attributeNames:Object.keys(remote.attributes??{})}:null;
 const read=api.inspect??api.get;
 const original=await read(receipt.sku),currentListing=current.sku===receipt.sku?original:await read(current.sku);
 const pricing=input.includePricing===true?await api.diagnosePrice(receipt.sku,receipt.asin,receipt.item_condition):undefined;
 const repair=typeof receipt.note==='string'&&receipt.note.startsWith('Amazon価格補正:')?JSON.parse(receipt.note.slice('Amazon価格補正:'.length)):null;
 const feed=input.includeFeed===true&&repair?.feed?.id?await api.priceFeedStatus(repair.feed.id):undefined;
 return{receipt:{requestId:receipt.request_id,sku:receipt.sku,asin:receipt.asin,price:receipt.price,condition:receipt.item_condition,channel:receipt.sales_channel,state:receipt.state},current:{id:current.id,sku:current.sku,asin:current.asin,price:current.planned_price,condition:current.condition,channel:current.sales_channel,status:current.status},original:summarize(original),currentListing:summarize(currentListing),pricing,feed};
}
// Explicit operator repair of an existing receipt, never used by automatic resume.
// A durable compare-and-set reservation prevents retries from repeating a PATCH.
export async function repairReceiptPrice(svc:any,input:Obj,connect=amazon){
 if(!['repair-receipt-price','repair-receipt-price-feed'].includes(input?.action)||!uuid(input.itemId)||!uuid(input.requestId))throw new SafeError(400,'対象の受付履歴を指定してください。');
 const feedMode=input.action==='repair-receipt-price-feed';
 const {data:r,error}=await svc.from('amazon_listing_submissions').select('*').eq('request_id',input.requestId).eq('item_id',input.itemId).maybeSingle();
 if(error||!r||!['accepted','uncertain','verified'].includes(r.state)||r.sku!==input.expectedSku||r.price!==input.expectedPrice||!Number.isSafeInteger(r.price)||r.price<1)throw new SafeError(409,'補正対象の受付履歴が一致しません。');
 const {data:current,error:itemError}=await svc.from('items').select(columns).eq('id',r.item_id).single();
 if(itemError||!current||current.sku!==input.expectedCurrentSku||current.asin!==r.asin||current.planned_price!==r.price||current.condition!==r.item_condition||current.sales_channel!==r.sales_channel)throw new SafeError(409,'現在の商品情報と補正価格が一致しません。');
 const api=await connect(accountFor(r.sales_channel));if(api.sellerId!==r.seller_id)throw new SafeError(409,'受付時の出品者が一致しません。');
 const remote=await api.get(r.sku),summary=remote?.summaries?.find((v:Obj)=>v.marketplaceId===marketplace);
 if(!remote||remote.sku!==r.sku||summary?.asin!==r.asin||summary?.conditionType!==conditionTypes[r.item_condition]||issues(remote).length)throw new SafeError(409,'既存のAmazon商品情報を照合できません。');
 const livePrice=effectivePrice(remote);
 if(livePrice===r.price)return{accepted:true,verified:true,sku:r.sku,price:livePrice,written:false};
 const previous=typeof r.note==='string'&&r.note.startsWith('Amazon価格補正:')?JSON.parse(r.note.slice('Amazon価格補正:'.length)):null;
 if(previous&&(!feedMode||previous.feed))return{accepted:true,verified:false,sku:r.sku,price:livePrice,written:false,note:'価格補正を送信済みです。再送せず反映を確認してください。'};
 if(feedMode&&(!previous||previous.state!=='accepted'||!Number.isFinite(Date.parse(previous.startedAt))||Date.now()-Date.parse(previous.startedAt)<600000))throw new SafeError(409,'既存の価格補正結果を先に確認してください。');
 const payload=receiptPricePatch(remote,r.price),preview=await api.patchPrice(r.sku,payload,true);
 if(!['VALID','ACCEPTED'].includes(preview?.status??'')||issues(preview).length)throw new SafeError(422,'Amazonが価格補正を受け付けませんでした。'+issues(preview).join(' '));
 const {data:latest,error:latestError}=await svc.from('items').select(columns).eq('id',current.id).single();
 if(latestError||!latest||!sameItem(current,latest))throw new SafeError(409,'補正の確認中に商品情報が変更されました。');
 const audit:Obj=feedMode?{...previous,feed:{startedAt:new Date().toISOString(),state:'sending'}}:{previousNote:r.note??null,startedAt:new Date().toISOString(),state:'sending',price:r.price,sku:r.sku,submissionId:null};
 const prefix='Amazon価格補正:',reservation=prefix+JSON.stringify(audit);
 let query=svc.from('amazon_listing_submissions').update({note:reservation}).eq('request_id',r.request_id).eq('state',r.state);
 query=r.note===null?query.is('note',null):query.eq('note',r.note);
 const {data:reserved,error:reserveError}=await query.select('request_id').maybeSingle();
 if(reserveError||!reserved)throw new SafeError(409,'価格補正の予約ができません。再送せず履歴を確認してください。');
 try{
  const result:Obj|null=feedMode?await api.submitPriceFeed(r.sku,payload):await api.patchPrice(r.sku,payload);
  if(result?.status!=='ACCEPTED'||issues(result).length)throw new SafeError(422,'Amazonが価格補正を受け付けませんでした。'+issues(result).join(' '));
  if(feedMode){audit.feed.state='accepted';audit.feed.id=result.feedId;}else{audit.state='accepted';audit.submissionId=typeof result.submissionId==='string'?result.submissionId:null;}
 }catch(e){if(feedMode)audit.feed.state=e instanceof SafeError&&e.status<500?'rejected':'uncertain';else audit.state=e instanceof SafeError&&e.status<500?'rejected':'uncertain';await svc.from('amazon_listing_submissions').update({note:prefix+JSON.stringify(audit)}).eq('request_id',r.request_id).eq('note',reservation);throw e;}
 const {error:saveError}=await svc.from('amazon_listing_submissions').update({note:prefix+JSON.stringify(audit)}).eq('request_id',r.request_id).eq('note',reservation);
 if(saveError)throw new SafeError(503,'Amazon受付後の補正履歴を保存できません。再送せず結果を確認してください。');
 const result=await api.get(r.sku);
 return{accepted:true,verified:!!result&&effectivePrice(result)===r.price,sku:r.sku,price:result?effectivePrice(result):null,written:true,submissionId:audit.submissionId,feedId:audit.feed?.id};
}
export async function handler(req:Request):Promise<Response>{
 const respond=(status:number,body:unknown)=>new Response(JSON.stringify(body),{status,headers});
 if(req.method==='OPTIONS')return new Response(null,{status:204,headers});if(req.method!=='POST')return respond(405,{error:'POSTのみ利用できます。'});
 try{
  if(req.headers.has('x-delivery-dispatch')){
   const svc=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,{auth:{persistSession:false,autoRefreshToken:false},db:{schema:'app'}});
   const {data:config,error}=await svc.rpc('delivery_push_config');
   if(error||!req.headers.get('x-delivery-dispatch')||req.headers.get('x-delivery-dispatch')!==config?.delivery_push_dispatch_token)throw new SafeError(401,'内部認証が必要です。');
   const input=await req.json().catch(()=>null);
   return respond(200,await(['repair-receipt-price','repair-receipt-price-feed'].includes(input?.action)?repairReceiptPrice(svc,input):inspectReceipt(svc,input)));
  }
  const authorization=req.headers.get('authorization')??'';if(!/^Bearer\s+\S+$/i.test(authorization))throw new SafeError(401,'ログインが必要です。');
  const options={auth:{persistSession:false,autoRefreshToken:false},db:{schema:'app'}};
  const sb=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_ANON_KEY')!,{...options,global:{headers:{Authorization:authorization}}});
  const {data:user,error:authError}=await sb.auth.getUser(authorization.replace(/^Bearer\s+/i,''));if(authError||!user.user)throw new SafeError(401,'ログインが無効です。');
  const body=await req.json().catch(()=>null);if(!body||!['submit','resume','check'].includes(body.action)||!uuid(body.itemId))throw new SafeError(400,'対象商品の指定が不正です。');
  const {data:item,error:itemError}=await sb.from('items').select(columns).eq('id',body.itemId).single();if(itemError||!item)throw new SafeError(404,'商品が見つかりません。');
  const [{data:staffId,error:staffError},{data:admin}]=await Promise.all([sb.rpc('current_staff_id'),sb.rpc('is_admin')]);
  const {data:staff,error:activeError}=await sb.from('staff').select('is_active').eq('id',staffId).single();
  if(staffError||activeError||!staff?.is_active||(!admin&&item.deliverer_id!==staffId))throw new SafeError(403,'この商品の出品権限がありません。');
  if(body.expectedSku!==undefined&&body.expectedSku!==item.sku||body.expectedPrice!==undefined&&body.expectedPrice!==item.planned_price)throw new SafeError(409,'確認後にSKUまたは予定販売価格が変更されています。出品画面を開き直してください。');
  if(!['商品登録前','出品中'].includes(item.status)||item.is_accessory&&!/^\d+c+[-_]/i.test(item.sku))throw new SafeError(409,'現在この商品を出品できません。');
  const accountId=accountFor(item.sales_channel),payload=listingBody(item);
  const svc=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,options);
  const {data:pending,error:pendingError}=await svc.from('amazon_listing_submissions').select('*').eq('item_id',item.id).in('state',['submitting','accepted','uncertain']).order('created_at',{ascending:false}).limit(1).maybeSingle();if(pendingError)throw new SafeError(503,'出品処理の履歴を確認できません。');
  let operation=pending as Obj|null;
  // Reconcile the original submission against its saved values before using current edits.
  const changedSubmission=()=>!!operation&&(operation.sku!==item.sku||operation.sales_channel!==item.sales_channel||operation.asin!==item.asin||operation.price!==item.planned_price||operation.item_condition!==item.condition||operation.description!==(item.description??''));
  const resuming=body.action==='resume';
  if(resuming&&!operation&&uuid(body.requestId)){const {data:prior,error}=await svc.from('amazon_listing_submissions').select('*').eq('request_id',body.requestId).maybeSingle();if(error)throw new SafeError(503,'出品処理の履歴を確認できません。');operation=prior;}
  if(resuming&&(!operation||operation.item_id!==item.id||operation.request_id!==body.requestId||changedSubmission()))throw new SafeError(409,'確認対象の出品内容が変更されています。出品画面を開き直してください。');
  const waiting=(state:string,note:string)=>respond(200,{verified:false,state,note,requestId:operation!.request_id,workCompletedOn:operation!.work_completed_on});
  if(body.action==='submit'&&operation&&changedSubmission()){
   const previousItem={...item,sku:operation.sku,asin:operation.asin,sales_channel:operation.sales_channel,planned_price:operation.price,condition:operation.item_condition,description:operation.description} as ListingItem;
   const previousApi=await amazon(accountFor(previousItem.sales_channel));
   if(previousApi.sellerId!==operation.seller_id)throw new SafeError(409,'以前のSKUの出品者情報が一致しません。');
   const previousListing=await previousApi.get(previousItem.sku);
   if(!previousListing||!verifiedListing(previousListing,previousItem))throw new SafeError(409,'以前のSKU '+previousItem.sku+' の登録確認が必要です。'+(previousListing?issues(previousListing).join(' ')||verificationNote(previousListing):'Amazonの登録結果をまだ確認できません。'));
   const {error:previousError}=await svc.from('amazon_listing_submissions').update({state:'verified',verified_at:new Date().toISOString(),note:'変更前の出品内容のAmazon登録を確認済み。現在の在庫状態は変更しません。'}).eq('request_id',operation.request_id);
   if(previousError)throw new SafeError(503,'以前のSKUの登録確認を保存できません。再度、結果を確認してください。');
   operation=null;
  }
  const api=await amazon(accountId);let remote=await api.get(item.sku);
  if(body.action==='check')return respond(200,{accountId,exists:!!remote,verified:!!remote&&verifiedListing(remote,item),state:operation?.state??null,note:remote?issues(remote).join(' ')||'AmazonにSKUの登録があります。':'AmazonにこのSKUはまだ登録されていません。'});
  if(resuming&&operation!.state==='verified'&&item.status==='出品中')return respond(200,{verified:true,state:'verified',accountId,note:'Amazonへの登録を確認しました。'});
  if(item.status!=='商品登録前')throw new SafeError(409,'Amazonに登録がない場合は、出品完了を取り消してから出品してください。');
  if(!uuid(body.requestId)||typeof body.workCompletedOn!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(body.workCompletedOn)||Number.isNaN(Date.parse(body.workCompletedOn))||new Date(body.workCompletedOn+'T00:00:00Z').toISOString().slice(0,10)!==body.workCompletedOn||body.workCompletedOn>new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Tokyo'}).format(new Date())||(item.purchased_at&&body.workCompletedOn<item.purchased_at))throw new SafeError(400,'作業完了日を確認してください。');
  const {data:approved,error:photoError}=await sb.rpc('listing_photos_approved',{p_item_id:item.id});if(photoError||approved!==true)throw new SafeError(409,'管理アプリで商品写真の承認が必要です。');
  const images=await approvedImages(sb,svc,item.id,body.photoIds);Object.assign(payload.attributes,images);
  if(!operation){
   const {data:prior,error:priorError}=await svc.from('amazon_listing_submissions').select('*').eq('request_id',body.requestId).maybeSingle();if(priorError)throw new SafeError(503,'操作IDを確認できません。');
   if(prior){if(prior.item_id!==item.id)throw new SafeError(409,'操作IDが重複しています。');operation=prior;}
  }
  if(changedSubmission())throw new SafeError(409,'変更前の出品操作を確認済みです。画面を開き直して現在の内容で操作してください。');
  let owned=false;
  if(!operation){
   if(remote&&!verifiedListing(remote,item))throw new SafeError(409,'同じSKUがAmazonにありますが、ASIN・価格・コンディション・配送方式が一致しません。既存の出品は上書きしません。');
   if(!remote){const catalog=await api.catalog(item.asin!);if(catalog.asin!==item.asin)throw new SafeError(409,'Amazonの商品情報のASINが一致しません。');Object.assign(payload.attributes,listingBody(item,catalog).attributes);const preview=await api.put(item.sku,payload,true);const errors=issues(preview);if(!['VALID','ACCEPTED'].includes(preview?.status??'')||errors.length)throw new SafeError(422,'Amazonが出品内容を受け付けませんでした。'+errors.join(' '));}
   const {data:latest,error:latestError}=await sb.from('items').select(columns).eq('id',item.id).single();if(latestError||!latest||!sameItem(item,latest))throw new SafeError(409,'商品情報が変更されています。再読み込みしてください。');
   const record={request_id:body.requestId,item_id:item.id,requested_by:user.user.id,sku:item.sku,asin:item.asin,sales_channel:item.sales_channel,account_id:accountId,seller_id:api.sellerId,price:item.planned_price,item_condition:item.condition,description:item.description??'',work_completed_on:body.workCompletedOn,state:'submitting'};
   const {data:inserted,error:insertError}=await svc.from('amazon_listing_submissions').insert(record).select().single();
   if(insertError){if(insertError.code!=='23505')throw new SafeError(503,'出品処理を記録できません。Amazonへの送信は行っていません。');const {data:concurrent,error}=await svc.from('amazon_listing_submissions').select('*').eq('item_id',item.id).in('state',['submitting','accepted','uncertain']).limit(1).maybeSingle();operation=concurrent;if(error||!operation||changedSubmission())throw new SafeError(409,'別の出品処理を確認中です。出品画面を開き直してください。');return waiting('submitting','同じ商品の登録処理を確認中です。');}
   operation=inserted;owned=true;
  }
  if(operation!.state==='failed')return waiting('failed',operation!.note||'前回の出品は失敗しました。内容を確認して再度お試しください。');
  if(owned&&!remote){
   try{
    const result=await api.put(item.sku,payload);const errors=issues(result);if(result?.status!=='ACCEPTED'||errors.length)throw new SafeError(422,'Amazonが出品を受け付けませんでした。'+errors.join(' '));
    const {error:saveError}=await svc.from('amazon_listing_submissions').update({state:'accepted',submission_id:typeof result.submissionId==='string'?result.submissionId:null,note:'Amazon受付済み・登録結果を確認中'}).eq('request_id',operation!.request_id);if(saveError)throw new SafeError(502,'Amazonは受け付けましたが履歴の更新に失敗しました。再送せず結果を確認してください。');
   }catch(e){const failed=e instanceof SafeError&&e.status>=400&&e.status<500;await svc.from('amazon_listing_submissions').update({state:failed?'failed':'uncertain',note:e instanceof SafeError?e.message:'Amazonへの送信結果が不明です。再送せず登録結果を確認します。'}).eq('request_id',operation!.request_id);throw e;}
  }
  if(!remote){try{remote=await api.get(item.sku);}catch{return waiting('accepted','Amazonへの送信を受け付けました。登録結果を確認中です。');}}
  if(remote&&issues(remote).length)throw new SafeError(422,'Amazonの商品登録にエラーがあります。'+issues(remote).join(' '));
  if(!remote||!verifiedListing(remote,item))return waiting(operation!.state==='uncertain'?'uncertain':'accepted',remote?issues(remote).join(' ')||verificationNote(remote):'Amazon受付済みです。SKUの登録を確認中です。');
  if(!verifiedImages(remote,images)){
   if(resuming)return waiting('accepted','Amazonに送信済みです。写真の反映を確認中です。');
   const imageKey='Amazon写真受付済み:'+Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([photoProductType(remote),Object.entries(images).map(([key,value])=>[key,new URL(value[0].media_location).pathname])]))))).map(value=>value.toString(16).padStart(2,'0')).join('');
   if(operation!.note===imageKey)return waiting('accepted','Amazonが商品写真を受け付けました。写真の登録結果を確認中です。'+imageProgress(remote,images)+'。再送せず登録結果を確認しています。');
   const preview=await api.patchImages(item.sku,images,remote,true);if(!['VALID','ACCEPTED'].includes(preview?.status??'')||issues(preview).length)throw new SafeError(422,'Amazonが商品写真を受け付けませんでした。'+issues(preview).join(' '));
   const {data:photoLatest,error:photoLatestError}=await sb.from('items').select(columns).eq('id',item.id).single();if(photoLatestError||!photoLatest||!sameItem(item,photoLatest))throw new SafeError(409,'商品情報が変更されています。再読み込みしてください。');
   const result=await api.patchImages(item.sku,images,remote);if(result?.status!=='ACCEPTED'||issues(result).length)throw new SafeError(422,'Amazonが商品写真を受け付けませんでした。'+issues(result).join(' '));
   const {error:imageReceiptError}=await svc.from('amazon_listing_submissions').update({state:'accepted',note:imageKey}).eq('request_id',operation!.request_id);if(imageReceiptError)throw new SafeError(503,'Amazonは写真を受け付けましたが、受付履歴を保存できませんでした。');
   remote=await api.get(item.sku);
   if(!remote||!verifiedListing(remote,item)||!verifiedImages(remote,images))return waiting('accepted','Amazonが商品写真を受け付けました。写真の登録結果を確認中です。'+imageProgress(remote,images)+'。登録結果を確認中です。');
  }
  const {data:latest,error:latestError}=await sb.from('items').select(columns).eq('id',item.id).single();if(latestError||!latest||!sameItem(item,latest))throw new SafeError(409,'Amazon送信後に商品情報が変更されています。内容を確認してください。');
  const {error:verifiedError}=await svc.from('amazon_listing_submissions').update({state:'verified',verified_at:new Date().toISOString(),note:'AmazonのSKU・ASIN・価格・コンディション・配送方式を確認済み'}).eq('request_id',operation!.request_id);if(verifiedError)throw new SafeError(503,'Amazonの登録確認を保存できません。再度結果を確認してください。');
  const {error:completeError}=await sb.rpc('perform_dated_inventory_action',{p_item_id:item.id,p_action:'listing_complete',p_expected_status:item.status,p_on:operation!.work_completed_on,p_request_id:operation!.request_id});if(completeError)throw new SafeError(409,'Amazonへの登録は確認済みですが、アプリの状態を更新できません。再度登録結果を確認してください。');
  return respond(200,{verified:true,state:'verified',accountId,note:'Amazonへの登録を確認しました。'});
 }catch(e){return respond(e instanceof SafeError||e instanceof AmazonAccountError?e.status:502,{error:e instanceof SafeError||e instanceof AmazonAccountError?e.message:'Amazonとの通信結果を確認できません。再送せず登録結果を確認してください。'});}
}
if(import.meta.main)Deno.serve(handler);
