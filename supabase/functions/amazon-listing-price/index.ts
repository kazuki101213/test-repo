import {createClient} from 'npm:@supabase/supabase-js@2.45.4';
import {amazonAccounts,amazonCredentials,amazonAccountId,AmazonAccountError,type AmazonAccountId} from '../_shared/amazonAccounts.ts';
const marketplace='A1VC38T7YXB528',endpoint='https://sellingpartnerapi-fe.amazon.com';
const headers={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type','Access-Control-Allow-Methods':'POST, OPTIONS','Content-Type':'application/json','Cache-Control':'no-store'};
class SafeError extends Error{constructor(public status:number,message:string){super(message)}}
type Obj=Record<string,any>;
type Item={id:string;sku:string;asin:string|null;sales_channel:string|null;status:string;is_accessory:boolean};
const isYen=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>0;
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
function offersOf(listing:Obj):Obj[]{return Array.isArray(listing.attributes?.purchasable_offer)?listing.attributes.purchasable_offer:[]}
function offerIndex(listing:Obj):number {const offers=offersOf(listing);const indexes=offers.map((o,i)=>({o,i})).filter(({o})=>o.currency==='JPY'&&(o.audience==='ALL'||o.audience===undefined)&&(!o.marketplace_id||o.marketplace_id===marketplace));return indexes.length===1?indexes[0].i:-1}
export function listingPrice(listing:Obj):number|null {const index=offerIndex(listing);if(index<0)return null;const offer=offersOf(listing)[index],prices=offer.our_price;if(!Array.isArray(prices)||prices.length!==1||!Array.isArray(prices[0]?.schedule)||prices[0].schedule.length!==1)return null;const schedule=prices[0].schedule[0];return !schedule.start_at&&!schedule.end_at&&isYen(schedule.value_with_tax)?schedule.value_with_tax:null;}
export function pricePatch(listing:Obj,price:number){
 if(!isYen(price)||listingPrice(listing)===null)throw new SafeError(422,'通常販売価格を一意に確認できません。Amazonの価格設定を確認してください。');
 const offers=structuredClone(offersOf(listing)),index=offerIndex(listing);
 // Preserve business offers, floor/ceiling prices, sale schedules and pricing rules.
 offers[index].our_price[0].schedule[0].value_with_tax=price;
 return {productType:listing.summaries?.find((s:Obj)=>s.marketplaceId===marketplace)?.productType||'PRODUCT',patches:[{op:'replace',path:'/attributes/purchasable_offer',value:offers}]};
}
function channelAccount(channel:string|null):AmazonAccountId|null {return /(?:Amazon|FBA|自己発送)[2２]$/.test(channel??'')?'amazon-2':/(?:Amazon|FBA|自己発送)[1１]$/.test(channel??'')?'amazon-1':null;}
function validateItem(item:Item){if(item.status!=='出品中'||!/^(?:FBA|自己発送|Amazon)(?:[12１２])?$/.test(item.sales_channel??'')||item.is_accessory&&!/^\d+c+[-_]/i.test(item.sku))throw new SafeError(409,'現在Amazonに個別出品中の商品ではありません。在庫を再読み込みしてください。');}
async function amazon(id:AmazonAccountId){
 const credentials=amazonCredentials(id),response=await fetch('https://api.amazon.com/auth/o2/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',client_id:credentials.clientId,client_secret:credentials.clientSecret,refresh_token:credentials.refreshToken}),signal:AbortSignal.timeout(15000)});
 const token=await response.json().catch(()=>null);if(!response.ok||typeof token?.access_token!=='string')throw new SafeError(502,`${id==='amazon-2'?'Amazon2':'Amazon1'}の認証に失敗しました。`);
 const call=async(path:string,params:URLSearchParams,body?:object)=>{const r=await fetch(endpoint+path+'?'+params,{method:body?'PATCH':'GET',headers:{'x-amz-access-token':token.access_token,'x-amz-date':new Date().toISOString().replace(/[:-]|\.\d{3}/g,''),'user-agent':'BussanAdmin/1.0 (Language=TypeScript; Platform=Supabase)','Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000)});const data=await r.json().catch(()=>null);if(!r.ok)throw new SafeError(502,`${id==='amazon-2'?'Amazon2':'Amazon1'}の価格APIが失敗しました（HTTP ${r.status}）。権限・アカウント状態を確認してください。`);return data as Obj;};
 const base='/listings/2021-08-01/items/'+encodeURIComponent(credentials.sellerId);
 return {get:(sku:string)=>call(base+'/'+encodeURIComponent(sku),new URLSearchParams({marketplaceIds:marketplace,includedData:'summaries,attributes'})),search:async(skus:string[])=>{const params=new URLSearchParams({marketplaceIds:marketplace,includedData:'summaries,attributes',identifiersType:'SKU',identifiers:skus.join(','),pageSize:'20'});const rows:Obj[]=[];for(let n=0;n<5;n++){const data=await call(base,params);if(!Array.isArray(data.items))throw new SafeError(502,'Amazonの出品情報が不正です。');rows.push(...data.items);if(!data.pagination?.nextToken)return rows;params.set('pageToken',data.pagination.nextToken);}throw new SafeError(502,'Amazonの出品情報を全件確認できませんでした。');},patch:(sku:string,body:object)=>call(base+'/'+encodeURIComponent(sku),new URLSearchParams({marketplaceIds:marketplace,issueLocale:'ja_JP'}),body)};
}
export async function handler(req:Request):Promise<Response>{
 const respond=(status:number,body:unknown)=>new Response(JSON.stringify(body),{status,headers});
 if(req.method==='OPTIONS')return new Response(null,{status:204,headers});if(req.method!=='POST')return respond(405,{error:'POSTのみ利用できます。'});
 try{
  const authorization=req.headers.get('authorization')??'';if(!/^Bearer\s+\S+$/i.test(authorization))throw new SafeError(401,'ログインが必要です。');
  const sb=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_ANON_KEY')!,{global:{headers:{Authorization:authorization}},auth:{persistSession:false,autoRefreshToken:false},db:{schema:'app'}});
  const {data:user,error:authError}=await sb.auth.getUser(authorization.replace(/^Bearer\s+/i,''));if(authError||!user.user)throw new SafeError(401,'ログインが無効です。');
  const {data:admin,error:roleError}=await sb.rpc('is_admin');if(roleError||admin!==true)throw new SafeError(403,'有効な管理者のみ利用できます。');
  const body=await req.json().catch(()=>null);if(!body||!['read','write'].includes(body.action))throw new SafeError(400,'操作の指定が不正です。');
  const ids=body.action==='read'?body.itemIds:[body.itemId];if(!Array.isArray(ids)||ids.length<1||ids.length>20||!ids.every(uuid))throw new SafeError(400,'対象商品の指定が不正です。');
  const {data:items,error}=await sb.from('items').select('id,sku,asin,sales_channel,status,is_accessory').in('id',ids);if(error)throw new SafeError(503,'在庫を確認できませんでした。');if(items?.length!==new Set(ids).size)throw new SafeError(404,'対象の在庫が見つかりません。');
  const rows=items as Item[];for(const item of rows)validateItem(item);if(rows.some(i=>i.sku.includes(',')))throw new SafeError(422,'このSKUは価格の一括取得に対応していません。');
  if(body.action==='read'){
   const found=new Map<string,Array<{accountId:AmazonAccountId;listing:Obj}>>(),failures:string[]=[];
   for(const account of amazonAccounts().filter(a=>a.configured)){
    try{const api=await amazon(account.id),candidates=rows.filter(i=>!channelAccount(i.sales_channel)||channelAccount(i.sales_channel)===account.id);if(!candidates.length)continue;const listings=await api.search(candidates.map(i=>i.sku));for(const listing of listings){const item=candidates.find(i=>i.sku===listing.sku),summary=listing.summaries?.find((s:Obj)=>s.marketplaceId===marketplace);if(!item||!summary||item.asin&&summary.asin!==item.asin)continue;found.set(item.id,[...(found.get(item.id)??[]),{accountId:account.id,listing}]);}}
    catch(e){failures.push(e instanceof SafeError||e instanceof AmazonAccountError?e.message:'Amazonへの接続に失敗しました。');}
   }
   return respond(200,{rows:rows.map(item=>{const matches=found.get(item.id)??[];if(matches.length!==1)return{id:item.id,sku:item.sku,price:null,error:matches.length>1?'両方のアカウントに同じSKUがあります。Amazon側の登録を確認してください。':failures.join(' ')||'接続済みのAmazonアカウントに同じSKUが見つかりません。'};const match=matches[0],price=listingPrice(match.listing);return{id:item.id,sku:item.sku,accountId:price===null?undefined:match.accountId,price,...(price===null?{error:'通常販売価格を一意に確認できません。Amazonの価格設定を確認してください。'}:{})};})});
  }
  const item=rows[0];if(!item||!isYen(body.price)||!isYen(body.expectedPrice))throw new SafeError(400,'価格は1円以上の整数で指定してください。');
  if(!body.accountId)throw new SafeError(400,'確認済みのAmazonアカウントを指定してください。');const accountId=amazonAccountId(body.accountId);if(channelAccount(item.sales_channel)&&channelAccount(item.sales_channel)!==accountId)throw new SafeError(409,'販売先のアカウントが一致しません。');
  const api=await amazon(accountId),listing=await api.get(item.sku),summary=listing.summaries?.find((s:Obj)=>s.marketplaceId===marketplace);
  if(!summary||item.asin&&summary.asin!==item.asin||listing.sku!==item.sku)throw new SafeError(409,'Amazonの商品情報が一致しません。再取得してください。');
  if(listingPrice(listing)!==body.expectedPrice)throw new SafeError(409,'Amazonの価格が変更されています。再取得してから反映してください。');
  const {data:latest,error:latestError}=await sb.from('items').select('sku,asin,status,sales_channel').eq('id',item.id).single();if(latestError||!latest||latest.sku!==item.sku||latest.asin!==item.asin||latest.status!==item.status||latest.sales_channel!==item.sales_channel)throw new SafeError(409,'在庫情報が変更されています。再読み込みしてください。');
  const result=await api.patch(item.sku,pricePatch(listing,body.price));
  if(result.status!=='ACCEPTED'||result.issues?.some((issue:Obj)=>issue.severity==='ERROR'))throw new SafeError(422,'Amazonが価格変更を受け付けませんでした。セラーセントラルの出品情報を確認してください。');
  let verified=false;try{verified=listingPrice(await api.get(item.sku))===body.price;}catch{/* The accepted write must not be retried because a read failed. */}
  return respond(200,{accepted:true,verified,accountId,price:body.price});
 }catch(e){return respond(e instanceof SafeError||e instanceof AmazonAccountError?e.status:502,{error:e instanceof SafeError||e instanceof AmazonAccountError?e.message:'Amazonへの通信に失敗しました。再取得して確認してください。'});}
}
if(import.meta.main)Deno.serve(handler);
