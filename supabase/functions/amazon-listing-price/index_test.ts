import {handler,listingPrice,pricePatch} from './index.ts';
const assert=(v:unknown,message='assertion failed')=>{if(!v)throw Error(message)};
const id='11111111-1111-4111-8111-111111111111',sku='9003c-AAII-20261029-40',marketplace='A1VC38T7YXB528';
const listing=()=>({sku,summaries:[{marketplaceId:marketplace,asin:'B000TEST01',productType:'ELECTRONIC_DEVICE'}],attributes:{purchasable_offer:[{audience:'ALL',currency:'JPY',marketplace_id:marketplace,our_price:[{schedule:[{value_with_tax:1000}]}],minimum_seller_allowed_price:[{schedule:[{value_with_tax:800}]}]},{audience:'B2B',currency:'JPY',our_price:[{schedule:[{value_with_tax:900}]}]}]}});
Deno.test('price patch preserves business prices and minimum price',()=>{const before=listing(),patch=pricePatch(before,1200);assert(patch.productType==='ELECTRONIC_DEVICE');assert(patch.patches[0].value[0].our_price[0].schedule[0].value_with_tax===1200);assert(patch.patches[0].value[1].our_price[0].schedule[0].value_with_tax===900);assert(patch.patches[0].value[0].minimum_seller_allowed_price[0].schedule[0].value_with_tax===800);assert(listingPrice(before)===1000,'must not mutate original');});
Deno.test('scheduled/ambiguous price is not editable',()=>{const row=listing();(row.attributes.purchasable_offer[0].our_price[0].schedule[0] as Record<string,unknown>).start_at='2026-12-01';assert(listingPrice(row)===null);let failed=false;try{pricePatch(row,100)}catch{failed=true}assert(failed)});
for(const mode of ['anonymous','nonadmin','read','duplicate','stale','wrongAsin','wrongAccount','stateChanged','invalidPrice','accepted','pending','verifyFails','rejected'])Deno.test(mode,async()=>{
 const originalFetch=globalThis.fetch,keys=['SUPABASE_URL','SUPABASE_ANON_KEY',...['AMAZON_','AMAZON_2_'].flatMap(prefix=>['LWA_CLIENT_ID','LWA_CLIENT_SECRET','LWA_REFRESH_TOKEN','SELLER_ID'].map(field=>prefix+field))],originalEnv=keys.map(k=>Deno.env.get(k));
 let amazonCalls=0,patches=0,gets=0,patchBody:Record<string,any>|null=null;const urls:string[]=[];
 const json=(body:unknown,status=200)=>Promise.resolve(new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}}));
 try{
  Deno.env.set('SUPABASE_URL','https://test.supabase.co');Deno.env.set('SUPABASE_ANON_KEY','test-key');for(const prefix of ['AMAZON_','AMAZON_2_'])for(const field of ['LWA_CLIENT_ID','LWA_CLIENT_SECRET','LWA_REFRESH_TOKEN','SELLER_ID'])Deno.env.set(prefix+field,prefix==='AMAZON_'?'one':'two');
  globalThis.fetch=((input:RequestInfo|URL,init?:RequestInit)=>{const url=String(input);urls.push(url);
   if(url.includes('/auth/v1/user'))return json({id:'admin',aud:'authenticated'});
   if(url.includes('/rpc/is_admin'))return json(mode!=='nonadmin');
   if(url.includes('/rest/v1/items'))return url.includes('select=sku%2Casin%2Cstatus%2Csales_channel')?json({sku,asin:'B000TEST01',sales_channel:'FBA',status:mode==='stateChanged'?'販売済':'出品中'}):json([{id,sku,asin:'B000TEST01',sales_channel:mode==='wrongAccount'?'FBA1':'FBA',status:'出品中',is_accessory:true}]);
   if(url.includes('/auth/o2/token'))return json({access_token:new URLSearchParams(String(init?.body)).get('client_id')});
   amazonCalls++;assert(url.startsWith('https://sellingpartnerapi-fe.amazon.com/'),'wrong endpoint');const second=url.includes('/two');
   if(init?.method==='PATCH'){patches++;assert(second,'must write only resolved account2');patchBody=JSON.parse(String(init.body));return json(mode==='rejected'?{status:'INVALID',issues:[{severity:'ERROR',message:'private-token'}]}:{status:'ACCEPTED'});}
   if(!url.includes(encodeURIComponent(sku)+'?'))return !second&&mode!=='duplicate'?json({errors:[{message:'private-token'}]},403):json({items:[listing()]});
   gets++;if(mode==='verifyFails'&&gets>1)return json({message:'private-token'},500);const row=listing();if(mode==='wrongAsin')row.summaries[0].asin='OTHER';if(mode==='stale'||mode==='accepted'&&gets>1)row.attributes.purchasable_offer[0].our_price[0].schedule[0].value_with_tax=1200;return json(row);
  })as typeof fetch;
  const body=['read','duplicate'].includes(mode)?{action:'read',itemIds:[id]}:{action:'write',itemId:id,accountId:'amazon-2',expectedPrice:1000,price:mode==='invalidPrice'?0:1200};
  const result=await handler(new Request('https://local',{method:'POST',headers:mode==='anonymous'?{}:{Authorization:'Bearer session'},body:JSON.stringify(body)})),data=await result.json();
  assert(!JSON.stringify(data).includes('private-token'),'upstream secrets must not be echoed');
  if(['anonymous','nonadmin'].includes(mode)){assert(result.status===(mode==='anonymous'?401:403));assert(amazonCalls===0)}
  else if(['read','duplicate'].includes(mode)){assert(result.status===200);assert(data.rows[0].accountId===(mode==='read'?'amazon-2':undefined));assert(patches===0)}
  else if(['accepted','pending','verifyFails'].includes(mode)){assert(result.status===200);assert(patches===1,'accepted writes never retried');assert(data.verified===(mode==='accepted'));assert((patchBody as any).patches[0].value[1].our_price[0].schedule[0].value_with_tax===900)}
  else{assert(result.status>=400,mode+' must fail');assert(patches===(mode==='rejected'?1:0),'unexpected write')}
 }finally{globalThis.fetch=originalFetch;keys.forEach((k,i)=>originalEnv[i]===undefined?Deno.env.delete(k):Deno.env.set(k,originalEnv[i]!))}
});
