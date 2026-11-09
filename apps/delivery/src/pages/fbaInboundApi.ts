import {getSupabase} from '@bussan/shared';
import type {Box,Plan,Shipment,Transport} from '../../../../supabase/functions/amazon-fba-inbound/workflow';

export type {Box,Shipment};
export type InboundPlan=Plan & {sender:{name:string;postalCode:string;stateOrProvinceCode:string;city:string;addressLine1:string;addressLine2?:string;phoneNumber:string}};
export const amount=(charges:{amount:number;code:string}[]=[])=>charges.length
 ? charges.map(x=>new Intl.NumberFormat('ja-JP',{style:'currency',currency:x.code}).format(x.amount)).join(' ＋ ')
 : 'Amazonからの請求なし';
const tokyoCalendar=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'});
export const tokyoDate=(daysAhead=0,now=new Date())=>tokyoCalendar.format(new Date(now.getTime()+daysAhead*86_400_000));

const isYamato=(option:Transport)=>[option.carrier,option.carrierCode].some(value=>value&&/ヤマト|クロネコ|yamato|kuroneko|^yamat$|^ymtjp$/i.test(value.normalize('NFKC').trim()));
const isJapanPost=(option:Transport)=>[option.carrier,option.carrierCode].some(value=>value&&/日本郵便|ゆうパック|japan\s*post|^npne$/i.test(value.normalize('NFKC').trim()));
export const fbaCarrierName=(option:Transport)=>isYamato(option)?'ヤマト運輸':isJapanPost(option)?'日本郵便':option.carrier;

export function fbaCarrierGroups(options:Transport[]) {
 const yamato=options.filter(isYamato);
 const japanPost=options.filter(isJapanPost);
 const major=[...yamato,...japanPost];
 const partnered=(option:Transport)=>option.solution==='AMAZON_PARTNERED_CARRIER';
 return {
  primary:[...major.filter(partnered),...major.filter(option=>!partnered(option))],
  other:options.filter(option=>!isYamato(option)&&!isJapanPost(option)),
 };
}
export function preferredFbaCarrier(options:Transport[]) {
 const yamato=options.filter(isYamato);
 return yamato.find(option=>option.solution==='AMAZON_PARTNERED_CARRIER')??yamato[0];
}
export class InboundRequestError extends Error {
 constructor(message:string,readonly status?:number){super(message);}
 get retryable(){
  return this.status===undefined||this.status===408||this.status===409||this.status===429||this.status>=500;
 }
}

export async function inboundRequest<T>(action:string, body:Record<string,unknown>={}):Promise<T>{
 const {data,error}=await getSupabase().functions.invoke('amazon-fba-inbound',{body:{action,...body}});
 if(error){
  const response=error.context instanceof Response?error.context:undefined;
  const details=await response?.json().catch(()=>null);
  throw new InboundRequestError(details?.error||'FBA納品を確認できません。時間をおいてもう一度お試しください。',response?.status);
 }
 return data as T;
}
