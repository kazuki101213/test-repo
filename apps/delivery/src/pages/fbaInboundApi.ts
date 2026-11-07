import {getSupabase} from '@bussan/shared';
import type {Box,Plan,Shipment} from '../../../../supabase/functions/amazon-fba-inbound/workflow';

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
export const tokyoDate=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
export async function inboundRequest<T>(action:string, body:Record<string,unknown>={}):Promise<T>{
 const {data,error}=await getSupabase().functions.invoke('amazon-fba-inbound',{body:{action,...body}});
 if(error){
  const details=error.context instanceof Response?await error.context.json().catch(()=>null):null;
  throw new Error(details?.error||'FBA納品を確認できません。時間をおいてもう一度お試しください。');
 }
 return data as T;
}
