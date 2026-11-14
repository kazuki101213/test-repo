import {handler,listingPrice,pricePatch,bindPriceItems} from './index.ts';
const assert=(v:unknown,message='assertion failed')=>{if(!v)throw Error(message)};
const id='11111111-1111-4111-8111-111111111111',sku='9003c-AAII-20261029-40',marketplace='A1VC38T7YXB528';
const listing=()=>({sku,summaries:[{marketplaceId:marketplace,asin:'B000TEST01',productType:'ELECTRONIC_DEVICE'}],attributes:{purchasable_offer:[{audience:'ALL',currency:'JPY',marketplace_id:marketplace,our_price:[{schedule:[{value_with_tax:1000}]}],minimum_seller_allowed_price:[{schedule:[{value_with_tax:800}]}]},{audience:'B2B',currency:'JPY',our_price:[{schedule:[{value_with_tax:900}]}]}]}});
Deno.test('price patch preserves business prices and minimum price',()=>{const before=listing(),patch=pricePatch(before,1200);assert(patch.productType==='ELECTRONIC_DEVICE');assert(patch.patches[0].value[0].our_price[0].schedule[0].value_with_tax===1200);assert(patch.patches[0].value[1].our_price[0].schedule[0].value_with_tax===900);assert(patch.patches[0].value[0].minimum_seller_allowed_price[0].schedule[0].value_with_tax===800);assert(listingPrice(before)===1000,'must not mutate original');});
Deno.test('scheduled/ambiguous price is not editable',()=>{const row=listing();(row.attributes.purchasable_offer[0].our_price[0].schedule[0] as Record<string,unknown>).start_at='2026-12-01';assert(listingPrice(row)===null);let failed=false;try{pricePatch(row,100)}catch{failed=true}assert(failed)});
Deno.test('price operations bind the verified Amazon SKU while preserving generated inventory identity',()=>{
 const item={id,sku:'9003c-AAII-20261029-34',asin:'B000TEST01',sales_channel:'自己発送2',status:'出品中',is_accessory:true};
 const receipt={item_id:id,sku,asin:item.asin,sales_channel:item.sales_channel,account_id:'amazon-2'};
 const [bound]=bindPriceItems([item],[receipt],[{item_id:id,sku}]);assert(bound.lookupSkus.length===1&&bound.lookupSkus[0]===sku&&bound.sku===item.sku&&bound.listingAccount==='amazon-2');
 let rejected=false;try{bindPriceItems([item],[receipt],[{item_id:'other-item',sku}])}catch{rejected=true}assert(rejected,'foreign alias must never redirect a price write');
});
for(const mode of ['anonymous','nonadmin','read','duplicate','stale','wrongAsin','wrongAccount','stateChanged','invalidPrice','accepted','pending','verifyFails','rejected',
 'linkedSkuRead','linkedSkuWrite','multipleLinkedListings','changedLinkedSku','staleLinkedSku'])Deno.test(mode,async()=>{
 const originalFetch=globalThis.fetch,keys=['SUPABASE_URL','SUPABASE_ANON_KEY',...['AMAZON_','AMAZON_2_'].flatMap(prefix=>['LWA_CLIENT_ID','LWA_CLIENT_SECRET','LWA_REFRESH_TOKEN','SELLER_ID'].map(field=>prefix+field))],originalEnv=keys.map(k=>Deno.env.get(k));
 let amazonCalls=0,patches=0,gets=0,patchBody:Record<string,any>|null=null;const urls:string[]=[];
 const linkedSku='123456789',linked=['linkedSkuRead','linkedSkuWrite','multipleLinkedListings','changedLinkedSku','staleLinkedSku'].includes(mode);
 let aliasReads=0,itemReads=0;
 const sellerListing=()=>({...listing(),sku:linked?linkedSku:sku});
 const json=(body:unknown,status=200)=>Promise.resolve(new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}}));
 try{
  Deno.env.set('SUPABASE_URL','https://test.supabase.co');Deno.env.set('SUPABASE_ANON_KEY','test-key');for(const prefix of ['AMAZON_','AMAZON_2_'])for(const field of ['LWA_CLIENT_ID','LWA_CLIENT_SECRET','LWA_REFRESH_TOKEN','SELLER_ID'])Deno.env.set(prefix+field,prefix==='AMAZON_'?'one':'two');
  globalThis.fetch=((input:RequestInfo|URL,init?:RequestInit)=>{const url=String(input);urls.push(url);
   if(url.includes('/auth/v1/user'))return json({id:'admin',aud:'authenticated'});
   if(url.includes('/rpc/is_admin'))return json(mode!=='nonadmin');
   if(url.includes('/rest/v1/items'))return json([{id,sku,asin:'B000TEST01',sales_channel:linked?'自己発送2':mode==='wrongAccount'?'FBA1':'FBA',
    status:++itemReads>1&&mode==='stateChanged'?'販売済':'出品中',is_accessory:!linked}]);
   if(url.includes('/rest/v1/amazon_listing_submissions'))return json([]);
   if(url.includes('/rest/v1/item_sku_aliases'))return json(linked&&!(++aliasReads>1&&mode==='changedLinkedSku')?[{item_id:id,sku:linkedSku}]:[]);
   if(url.includes('/auth/o2/token'))return json({access_token:new URLSearchParams(String(init?.body)).get('client_id')});
   amazonCalls++;assert(url.startsWith('https://sellingpartnerapi-fe.amazon.com/'),'wrong endpoint');const second=url.includes('/two');
   if(linked)assert(second,'linked SKU must use Amazon2');
   if(init?.method==='PATCH'){patches++;assert(second,'must write only resolved account2');if(linked)assert(url.includes('/'+linkedSku+'?'));patchBody=JSON.parse(String(init.body));return json(mode==='rejected'?{status:'INVALID',issues:[{severity:'ERROR',message:'private-token'}]}:{status:'ACCEPTED'});}
   const params=new URL(url).searchParams;
   if(params.has('identifiers')){
    if(linked)assert(params.get('identifiers')?.split(',').includes(linkedSku));
    return !second&&mode!=='duplicate'?json({errors:[{message:'private-token'}]},403):json({items:mode==='multipleLinkedListings'?[listing(),sellerListing()]:[sellerListing()]});
   }
   gets++;if(mode==='verifyFails'&&gets>1)return json({message:'private-token'},500);const row=sellerListing();if(mode==='wrongAsin')row.summaries[0].asin='OTHER';if(mode==='stale'||['accepted','linkedSkuWrite'].includes(mode)&&gets>1)row.attributes.purchasable_offer[0].our_price[0].schedule[0].value_with_tax=1200;return json(row);
  })as typeof fetch;
  const read=['read','duplicate','linkedSkuRead','multipleLinkedListings'].includes(mode);
  const body=read?{action:'read',itemIds:[id]}:{action:'write',itemId:id,accountId:'amazon-2',expectedPrice:1000,price:mode==='invalidPrice'?0:1200,
   ...(linked?{sellerSku:mode==='staleLinkedSku'?sku:linkedSku}:{})};
  const result=await handler(new Request('https://local',{method:'POST',headers:mode==='anonymous'?{}:{Authorization:'Bearer session'},body:JSON.stringify(body)})),data=await result.json();
  assert(!JSON.stringify(data).includes('private-token'),'upstream secrets must not be echoed');
  if(['anonymous','nonadmin'].includes(mode)){assert(result.status===(mode==='anonymous'?401:403));assert(amazonCalls===0)}
  else if(read){assert(result.status===200);assert(data.rows[0].accountId===(['read','linkedSkuRead'].includes(mode)?'amazon-2':undefined));if(mode==='linkedSkuRead')assert(data.rows[0].sellerSku===linkedSku&&data.rows[0].sku===sku);assert(patches===0)}
  else if(['accepted','pending','verifyFails','linkedSkuWrite'].includes(mode)){assert(result.status===200);assert(patches===1,'accepted writes never retried');assert(data.verified===['accepted','linkedSkuWrite'].includes(mode));assert((patchBody as any).patches[0].value[1].our_price[0].schedule[0].value_with_tax===900)}
  else{assert(result.status>=400,mode+' must fail');assert(patches===(mode==='rejected'?1:0),'unexpected write')}
 }finally{globalThis.fetch=originalFetch;keys.forEach((k,i)=>originalEnv[i]===undefined?Deno.env.delete(k):Deno.env.set(k,originalEnv[i]!))}
});
