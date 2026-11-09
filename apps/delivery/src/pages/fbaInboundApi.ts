import {getSupabase} from '@bussan/shared';
import type {Box,Plan,Shipment,Transport} from '../../../../supabase/functions/amazon-fba-inbound/workflow';

export type {Box,Shipment};
export type InboundPlan=Plan & {sender:{name:string;postalCode:string;stateOrProvinceCode:string;city:string;addressLine1:string;addressLine2?:string;phoneNumber:string}};
export const fbaState:Record<Plan['stage'],string>={
 draft:'下書き',created:'Amazonに納品プランを作成済み','packing-options':'梱包方法の選択',
 'packing-confirmed':'輸送箱の確定',packed:'箱情報を送信済み','placement-options':'納品先の選択',
 'transport-options':'配送方法の選択','placement-confirmed':'配送の確定',ready:'発送・受領確認',cancelled:'取消済み',
};
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
export async function inboundRequest<T>(action:string, body:Record<string,unknown>={}):Promise<T>{
 const {data,error}=await getSupabase().functions.invoke('amazon-fba-inbound',{body:{action,...body}});
 if(error){
  const details=error.context instanceof Response?await error.context.json().catch(()=>null):null;
  throw new Error(details?.error||'FBA納品を確認できません。時間をおいてもう一度お試しください。');
 }
 return data as T;
}
