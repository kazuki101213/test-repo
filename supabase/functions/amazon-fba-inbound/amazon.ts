import {amazonCredentials} from '../_shared/amazonAccounts.ts';
import {type Account,WorkflowError,type Charge} from './workflow.ts';

export const marketplace='A1VC38T7YXB528';
const endpoint='https://sellingpartnerapi-fe.amazon.com';
export const inbound='/inbound/fba/2024-03-20';
export const expectedSeller={FBA1:'A1WI3OGPE43N2T',FBA2:'A3E7BXJWH9TP11'};
export class AmazonError extends WorkflowError {
 constructor(public remoteStatus:number,message:string){super(remoteStatus===429?429:502,message);}
}
export function amazonProblem(value:any) {
 const code=String(value?.code??'').replace(/[^a-zA-Z0-9_-]/g,'').slice(0,40);
 const message=String(value?.message??'').replace(/https?:\/\/\S+/g,'[URL]').replace(/[\r\n]+/g,' ').slice(0,320);
 return [code,message].filter(Boolean).join('：');
}
export async function amazonClient(account:Account) {
 const {clientId,clientSecret,refreshToken,sellerId}=amazonCredentials(account==='FBA1'?'amazon-1':'amazon-2');
 if(sellerId!==expectedSeller[account]) throw new WorkflowError(503,`${account}のAmazonアカウント設定を確認してください。`);
 const lwa=await fetch('https://api.amazon.com/auth/o2/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
  body:new URLSearchParams({grant_type:'refresh_token',client_id:clientId,client_secret:clientSecret,refresh_token:refreshToken}),signal:AbortSignal.timeout(8000)});
 const accessToken=lwa.ok?(await lwa.json()).access_token:null;
 if(typeof accessToken!=='string'||!accessToken) throw new WorkflowError(502,`${account}のAmazon認可を確認してください。`);
 async function call(path:string, query:Record<string,string|string[]>={}, method='GET', body?:unknown) {
  const url=new URL(endpoint+path);
  for(const [k,v] of Object.entries(query)) for(const value of (Array.isArray(v)?v:[v]))url.searchParams.append(k,value);
  let response:Response;
  try {response=await fetch(url,{method,headers:{'Content-Type':'application/json','x-amz-access-token':accessToken,'User-Agent':'BussanDelivery/1.0 (Language=TypeScript; Platform=Supabase)'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(9000)});}
  catch {throw new AmazonError(0,'Amazonに接続できません。時間をおいて結果を確認してください。');}
  const json=await response.json().catch(()=>null);
  if(!response.ok) throw new AmazonError(response.status,response.status===403
   ? `${account}のFBA納品APIへのアクセスがAmazonに拒否されました。アカウントの状態とアプリの権限を確認してください。`
   : 'Amazon：'+((json?.errors??[]).map(amazonProblem).filter(Boolean).slice(0,2).join('／')||`応答 ${response.status}`));
  return json??{};
 }
 async function pages(path:string, field:string, query:Record<string,string>={}) {
  const result:any[]=[];let token='';
  for(let page=0;page<12;page++){
   const response=await call(path,{pageSize:'50',...query,...(token?{paginationToken:token}:{})});
   if(!Array.isArray(response[field])) throw new WorkflowError(502,'Amazonから一覧を確認できません。');
   result.push(...response[field]);token=response.pagination?.nextToken;
   if(!token)return result;
  }
  throw new WorkflowError(502,'Amazonの一覧をすべて取得できません。');
 }
 return {call,pages,sellerId};
}
export type Amazon=Awaited<ReturnType<typeof amazonClient>>;
export const enc=encodeURIComponent;
export const planPath=(id:string)=>inbound+'/inboundPlans/'+enc(id);
export const charge=(value:any):Charge|undefined=>typeof value?.amount==='number'&&/^[A-Z]{3}$/.test(value?.code)?{amount:value.amount,code:value.code}:undefined;
export function charges(rows:any):Charge[] {return Array.isArray(rows)?rows.flatMap(x=>{const fee=charge(x.value??x.cost);return fee?[fee]:[];}):[];}
export function amazonPdfUrl(value:unknown) {
 if(typeof value!=='string') throw new WorkflowError(502,'Amazonから配送ラベルのURLを取得できません。');
 const url=new URL(value);
 if(url.protocol!=='https:'||url.username||url.password||!/(?:^|\.)(amazonaws\.com|amazon\.com|amazon\.co\.jp|media-amazon\.com)$/.test(url.hostname)) {
  throw new WorkflowError(502,'Amazonの配送ラベルのURLを確認できません。');
 }
 return url.href;
}
