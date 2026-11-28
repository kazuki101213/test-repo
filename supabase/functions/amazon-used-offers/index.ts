// 読み取り専用：ASINごとの今出ている中古出品（状態・FBAかどうか・価格）をSP-APIの価格APIで取る。管理者のみ。2026-11-28
import {createClient} from 'npm:@supabase/supabase-js@2.45.4';
import {amazonCredentials,AmazonAccountError,type AmazonAccountId} from '../_shared/amazonAccounts.ts';
const marketplace='A1VC38T7YXB528',endpoint='https://sellingpartnerapi-fe.amazon.com';
const headers={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type','Access-Control-Allow-Methods':'POST, OPTIONS','Content-Type':'application/json','Cache-Control':'no-store'};
const respond=(s:number,b:unknown)=>new Response(JSON.stringify(b),{status:s,headers});
Deno.serve(async req=>{
 if(req.method==='OPTIONS')return new Response(null,{status:204,headers});
 try{
  const authorization=req.headers.get('authorization')??'';
  const sb=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_ANON_KEY')!,{global:{headers:{Authorization:authorization}},auth:{persistSession:false},db:{schema:'app'}});
  const {data:admin}=await sb.rpc('is_admin');if(admin!==true)return respond(403,{error:'管理者のみ'});
  const body=await req.json().catch(()=>null);
  const accountId:AmazonAccountId=body?.accountId==='amazon-1'?'amazon-1':'amazon-2';
  const asins:string[]=Array.isArray(body?.asins)?body.asins.filter((a:unknown)=>typeof a==='string'&&/^[A-Z0-9]{10}$/.test(a)).slice(0,20):[];
  if(!asins.length)return respond(400,{error:'ASINを1〜20件指定してください'});
  const c=amazonCredentials(accountId);
  const t=await fetch('https://api.amazon.com/auth/o2/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',client_id:c.clientId,client_secret:c.clientSecret,refresh_token:c.refreshToken})}).then(r=>r.json());
  if(!t?.access_token)return respond(502,{error:'認証失敗'});
  const reqs=asins.map(a=>({uri:'/products/pricing/v0/items/'+a+'/offers',method:'GET',MarketplaceId:marketplace,ItemCondition:'Used',CustomerType:'Consumer'}));
  const r=await fetch(endpoint+'/batches/products/pricing/v0/itemOffers',{method:'POST',headers:{'x-amz-access-token':t.access_token,'content-type':'application/json','user-agent':'BussanAdmin/1.0'},body:JSON.stringify({requests:reqs})});
  const data=await r.json().catch(()=>null);
  if(!r.ok)return respond(502,{error:'価格APIが失敗（HTTP '+r.status+'）',detail:JSON.stringify(data).slice(0,300)});
  // deno-lint-ignore no-explicit-any
  const rows=(data.responses||[]).map((x:any,i:number)=>{
   // deno-lint-ignore no-explicit-any
   const p=x.body?.payload;const offers=(p?.Offers||[]).map((o:any)=>({sub:o.SubCondition,fba:!!o.IsFulfilledByAmazon,price:(o.ListingPrice?.Amount??0)+(o.Shipping?.Amount??0)}));
   // deno-lint-ignore no-explicit-any
   const vgFba=offers.filter((o:any)=>o.sub==='very_good'&&o.fba).map((o:any)=>o.price);
   // deno-lint-ignore no-explicit-any
   const vgAll=offers.filter((o:any)=>o.sub==='very_good').map((o:any)=>o.price);
   // deno-lint-ignore no-explicit-any
   return {asin:asins[i],status:x.status?.statusCode,error:x.body?.errors?.[0]?.message,offerCount:offers.length,vgFbaMin:vgFba.length?Math.min(...vgFba):null,vgFbaCount:vgFba.length,vgMin:vgAll.length?Math.min(...vgAll):null,usedMin:offers.length?Math.min(...offers.map((o:any)=>o.price)):null};
  });
  return respond(200,{rows});
 }catch(e){return respond(e instanceof AmazonAccountError?e.status:502,{error:e instanceof Error?e.message:'失敗'});}
});
