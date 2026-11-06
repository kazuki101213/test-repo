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
 return listing.sku===item.sku&&summary?.asin===item.asin&&summary?.conditionType===conditionTypes[item.condition??'']&&schedules?.length===1&&schedules[0].value_with_tax===item.planned_price&&!schedules[0].start_at&&!schedules[0].end_at&&(attributes.fulfillment_availability??[]).some((v:Obj)=>v.fulfillment_channel_code===(/^FBA/.test(item.sales_channel??'')?'AMAZON_JP':'DEFAULT'))&&issues(listing).length===0;
}
function verificationNote(listing:Obj):string{
 const s=listing.summaries?.find((v:Obj)=>v.marketplaceId===marketplace),a=listing.attributes??{};
 const prices=(a.purchasable_offer??[]).flatMap((o:Obj)=>(o.our_price??[]).flatMap((p:Obj)=>(p.schedule??[]).map((v:Obj)=>v.value_with_tax))).filter((v:unknown)=>typeof v==='number'&&Number.isFinite(v));
 const price=prices.length?'¥'+prices.join(' / ¥'):'未取得',condition=Object.entries(conditionTypes).find(([,value])=>value===s?.conditionType)?.[0]??'未取得';
 const channels=(a.fulfillment_availability??[]).map((v:Obj)=>v.fulfillment_channel_code).filter((v:unknown)=>v==='AMAZON_JP'||v==='DEFAULT');
 return 'Amazonの反映を確認中です（ASIN '+(/^[A-Z0-9]{10}$/.test(s?.asin??'')?s!.asin:'未取得')+'、コンディション '+condition+'、価格 '+price+'、配送 '+(channels.join('/')||'未取得')+'）。再度、登録結果を確認してください。';
}
function sameItem(a:ListingItem,b:ListingItem){return['sku','asin','condition','description','planned_price','sales_channel','status'].every(k=>a[k as keyof ListingItem]===b[k as keyof ListingItem]);}
async function amazon(id:AmazonAccountId){
 const credentials=amazonCredentials(id),expected=id==='amazon-2'?'A3E7BXJWH9TP11':'A1WI3OGPE43N2T';if(credentials.sellerId!==expected)throw new SafeError(503,'販売先とAmazon出品者IDの設定が一致しません。');
 const r=await fetch('https://api.amazon.com/auth/o2/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',client_id:credentials.clientId,client_secret:credentials.clientSecret,refresh_token:credentials.refreshToken}),signal:AbortSignal.timeout(15000)});
 const token=await r.json().catch(()=>null);if(!r.ok||!token?.access_token)throw new SafeError(502,'Amazonの認証に失敗しました。');
 const path='/listings/2021-08-01/items/'+encodeURIComponent(credentials.sellerId)+'/';
 async function call(sku:string,method:'GET'|'PUT',body?:Obj,preview=false){
  const params=new URLSearchParams({marketplaceIds:marketplace,issueLocale:'ja_JP',includedData:method==='GET'?'summaries,attributes,issues':'issues'});if(preview)params.set('mode','VALIDATION_PREVIEW');
  const response=await fetch(endpoint+path+encodeURIComponent(sku)+'?'+params,{method,headers:{'x-amz-access-token':token.access_token,'x-amz-date':new Date().toISOString().replace(/[:-]|\.\d{3}/g,''),'Content-Type':'application/json','user-agent':'BussanDelivery/1.0 (Language=TypeScript; Platform=Supabase)'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(20000)});
  const data=await response.json().catch(()=>null);if(method==='GET'&&response.status===404)return null;
  if(!response.ok)throw new SafeError(response.status>=500?502:response.status,'Amazon登録APIがエラーになりました（HTTP '+response.status+'）。'+(issues(data).join(' ')||'アカウントの権限・状態を確認してください。'));
  if(!data||typeof data!=='object')throw new SafeError(502,'Amazonの登録結果を確認できません。');return data as Obj;
 }
 return{sellerId:credentials.sellerId,catalog:async(asin:string)=>{const params=new URLSearchParams({marketplaceIds:marketplace,includedData:'attributes'});const r=await fetch(endpoint+'/catalog/2022-04-01/items/'+encodeURIComponent(asin)+'?'+params,{headers:{'x-amz-access-token':token.access_token,'user-agent':'BussanDelivery/1.0'},signal:AbortSignal.timeout(15000)});if(!r.ok)throw new SafeError(502,'Amazonの商品情報を取得できません（HTTP '+r.status+'）。');return await r.json() as Obj;},get:(sku:string)=>call(sku,'GET'),put:(sku:string,body:Obj,preview=false)=>call(sku,'PUT',body,preview)};
}
export async function handler(req:Request):Promise<Response>{
 const respond=(status:number,body:unknown)=>new Response(JSON.stringify(body),{status,headers});
 if(req.method==='OPTIONS')return new Response(null,{status:204,headers});if(req.method!=='POST')return respond(405,{error:'POSTのみ利用できます。'});
 try{
  const authorization=req.headers.get('authorization')??'';if(!/^Bearer\s+\S+$/i.test(authorization))throw new SafeError(401,'ログインが必要です。');
  const options={auth:{persistSession:false,autoRefreshToken:false},db:{schema:'app'}};
  const sb=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_ANON_KEY')!,{...options,global:{headers:{Authorization:authorization}}});
  const {data:user,error:authError}=await sb.auth.getUser(authorization.replace(/^Bearer\s+/i,''));if(authError||!user.user)throw new SafeError(401,'ログインが無効です。');
  const body=await req.json().catch(()=>null);if(!body||!['submit','check'].includes(body.action)||!uuid(body.itemId))throw new SafeError(400,'対象商品の指定が不正です。');
  const {data:item,error:itemError}=await sb.from('items').select(columns).eq('id',body.itemId).single();if(itemError||!item)throw new SafeError(404,'商品が見つかりません。');
  const [{data:staffId,error:staffError},{data:admin}]=await Promise.all([sb.rpc('current_staff_id'),sb.rpc('is_admin')]);
  const {data:staff,error:activeError}=await sb.from('staff').select('is_active').eq('id',staffId).single();
  if(staffError||activeError||!staff?.is_active||(!admin&&item.deliverer_id!==staffId))throw new SafeError(403,'この商品の出品権限がありません。');
  if(!['商品登録前','出品中'].includes(item.status)||item.is_accessory&&!/^\d+c+[-_]/i.test(item.sku))throw new SafeError(409,'現在この商品を出品できません。');
  const accountId=accountFor(item.sales_channel),payload=listingBody(item);
  const svc=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,options);
  const {data:pending,error:pendingError}=await svc.from('amazon_listing_submissions').select('*').eq('item_id',item.id).in('state',['submitting','accepted','uncertain']).order('created_at',{ascending:false}).limit(1).maybeSingle();if(pendingError)throw new SafeError(503,'出品処理の履歴を確認できません。');
  let operation=pending as Obj|null;
  // Finish the earlier SKU's evidence without applying its status to a renamed item.
  if(body.action==='submit'&&operation&&operation.sku!==item.sku){
   const previousItem={...item,sku:operation.sku,asin:operation.asin,sales_channel:operation.sales_channel,planned_price:operation.price,condition:operation.item_condition,description:operation.description} as ListingItem;
   const previousApi=await amazon(accountFor(previousItem.sales_channel));
   if(previousApi.sellerId!==operation.seller_id)throw new SafeError(409,'以前のSKUの出品者情報が一致しません。');
   const previousListing=await previousApi.get(previousItem.sku);
   if(!previousListing||!verifiedListing(previousListing,previousItem))throw new SafeError(409,'以前のSKU '+previousItem.sku+' の登録確認が必要です。'+(previousListing?issues(previousListing).join(' ')||verificationNote(previousListing):'Amazonの登録結果をまだ確認できません。'));
   const {error:previousError}=await svc.from('amazon_listing_submissions').update({state:'verified',verified_at:new Date().toISOString(),note:'以前のSKUのAmazon登録を確認済み。通番号・SKUの変更後の在庫状態は変更しません。'}).eq('request_id',operation.request_id);
   if(previousError)throw new SafeError(503,'以前のSKUの登録確認を保存できません。再度、結果を確認してください。');
   operation=null;
  }
  if(operation&&(operation.sku!==item.sku||operation.sales_channel!==item.sales_channel||operation.asin!==item.asin||operation.price!==item.planned_price||operation.item_condition!==item.condition||operation.description!==(item.description??'')))throw new SafeError(409,'送信後に商品情報が変更されています。Amazonの登録内容を確認してください。');
  const api=await amazon(accountId);let remote=await api.get(item.sku);
  if(body.action==='check')return respond(200,{accountId,exists:!!remote,verified:!!remote&&verifiedListing(remote,item),state:operation?.state??null,note:remote?issues(remote).join(' ')||'AmazonにSKUの登録があります。':'AmazonにこのSKUはまだ登録されていません。'});
  if(item.status!=='商品登録前')throw new SafeError(409,'Amazonに登録がない場合は、出品完了を取り消してから出品してください。');
  if(!uuid(body.requestId)||typeof body.workCompletedOn!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(body.workCompletedOn)||Number.isNaN(Date.parse(body.workCompletedOn))||new Date(body.workCompletedOn+'T00:00:00Z').toISOString().slice(0,10)!==body.workCompletedOn||body.workCompletedOn>new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Tokyo'}).format(new Date())||(item.purchased_at&&body.workCompletedOn<item.purchased_at))throw new SafeError(400,'作業完了日を確認してください。');
  const {data:approved,error:photoError}=await sb.rpc('listing_photos_approved',{p_item_id:item.id});if(photoError||approved!==true)throw new SafeError(409,'管理アプリで商品写真の承認が必要です。');
  if(!operation){
   const {data:prior,error:priorError}=await svc.from('amazon_listing_submissions').select('*').eq('request_id',body.requestId).maybeSingle();if(priorError)throw new SafeError(503,'操作IDを確認できません。');
   if(prior){if(prior.item_id!==item.id)throw new SafeError(409,'操作IDが重複しています。');operation=prior;}
  }
  let owned=false;
  if(!operation){
   if(remote&&!verifiedListing(remote,item))throw new SafeError(409,'同じSKUがAmazonにありますが、ASIN・価格・コンディション・配送方式が一致しません。既存の出品は上書きしません。');
   if(!remote){const catalog=await api.catalog(item.asin!);if(catalog.asin!==item.asin)throw new SafeError(409,'Amazonの商品情報のASINが一致しません。');Object.assign(payload.attributes,listingBody(item,catalog).attributes);const preview=await api.put(item.sku,payload,true);const errors=issues(preview);if(!['VALID','ACCEPTED'].includes(preview?.status??'')||errors.length)throw new SafeError(422,'Amazonが出品内容を受け付けませんでした。'+errors.join(' '));}
   const {data:latest,error:latestError}=await sb.from('items').select(columns).eq('id',item.id).single();if(latestError||!latest||!sameItem(item,latest))throw new SafeError(409,'商品情報が変更されています。再読み込みしてください。');
   const record={request_id:body.requestId,item_id:item.id,requested_by:user.user.id,sku:item.sku,asin:item.asin,sales_channel:item.sales_channel,account_id:accountId,seller_id:api.sellerId,price:item.planned_price,item_condition:item.condition,description:item.description??'',work_completed_on:body.workCompletedOn,state:'submitting'};
   const {data:inserted,error:insertError}=await svc.from('amazon_listing_submissions').insert(record).select().single();
   if(insertError){if(insertError.code!=='23505')throw new SafeError(503,'出品処理を記録できません。Amazonへの送信は行っていません。');return respond(200,{verified:false,state:'submitting',note:'同じ商品の登録処理を確認中です。もう一度、登録結果を確認してください。'});}
   operation=inserted;owned=true;
  }
  if(operation!.state==='failed')return respond(200,{verified:false,state:'failed',note:operation!.note||'前回の出品は失敗しました。内容を確認して再度お試しください。'});
  if(owned&&!remote){
   try{
    const result=await api.put(item.sku,payload);const errors=issues(result);if(result?.status!=='ACCEPTED'||errors.length)throw new SafeError(422,'Amazonが出品を受け付けませんでした。'+errors.join(' '));
    const {error:saveError}=await svc.from('amazon_listing_submissions').update({state:'accepted',submission_id:typeof result.submissionId==='string'?result.submissionId:null,note:'Amazon受付済み・登録結果を確認中'}).eq('request_id',operation!.request_id);if(saveError)throw new SafeError(502,'Amazonは受け付けましたが履歴の更新に失敗しました。再送せず結果を確認してください。');
   }catch(e){const failed=e instanceof SafeError&&e.status>=400&&e.status<500;await svc.from('amazon_listing_submissions').update({state:failed?'failed':'uncertain',note:e instanceof SafeError?e.message:'Amazonへの送信結果が不明です。再送せず登録結果を確認します。'}).eq('request_id',operation!.request_id);throw e;}
  }
  if(!remote){try{remote=await api.get(item.sku);}catch{return respond(200,{verified:false,state:'accepted',note:'Amazonへの送信を受け付けました。登録結果の取得を再度お試しください。'});}}
  if(!remote||!verifiedListing(remote,item))return respond(200,{verified:false,state:operation!.state==='uncertain'?'uncertain':'accepted',note:remote?issues(remote).join(' ')||verificationNote(remote):'Amazon受付済みです。まだSKUの登録を確認できません。少し待って登録結果を確認してください。'});
  const {data:latest,error:latestError}=await sb.from('items').select(columns).eq('id',item.id).single();if(latestError||!latest||!sameItem(item,latest))throw new SafeError(409,'Amazon送信後に商品情報が変更されています。内容を確認してください。');
  const {error:verifiedError}=await svc.from('amazon_listing_submissions').update({state:'verified',verified_at:new Date().toISOString(),note:'AmazonのSKU・ASIN・価格・コンディション・配送方式を確認済み'}).eq('request_id',operation!.request_id);if(verifiedError)throw new SafeError(503,'Amazonの登録確認を保存できません。再度結果を確認してください。');
  const {error:completeError}=await sb.rpc('perform_dated_inventory_action',{p_item_id:item.id,p_action:'listing_complete',p_expected_status:item.status,p_on:operation!.work_completed_on,p_request_id:operation!.request_id});if(completeError)throw new SafeError(409,'Amazonへの登録は確認済みですが、アプリの状態を更新できません。再度登録結果を確認してください。');
  return respond(200,{verified:true,state:'verified',accountId,note:'Amazonへの登録を確認しました。'});
 }catch(e){return respond(e instanceof SafeError||e instanceof AmazonAccountError?e.status:502,{error:e instanceof SafeError||e instanceof AmazonAccountError?e.message:'Amazonとの通信結果を確認できません。再送せず登録結果を確認してください。'});}
}
if(import.meta.main)Deno.serve(handler);
