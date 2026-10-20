import type {DeliveryTask} from './types';
export interface SellerDraft {
 title:string;description:string;price:number;condition:string;shippingMethod:string;shippingPayer:string;dispatchDays:string;origin:string;
 category:'ブルーレイレコーダー'|'テレビ'|'モニター'|'小物';listingCategory?:string;size:string;weightKg?:string;dropoff:string;auctionDays:number;closingHour:number;autoExtend:boolean;autoRelist:boolean;
}
export const SMALL_PACKAGES=[
 {name:'宅急便コンパクト',dimensions:'専用BOX：25×20×5cm'},
 {name:'ゆうパケットプラス',dimensions:'専用箱：24×17×7cm・2kg以内'},
 {name:'ゆうパケットポストmini',dimensions:'専用封筒内寸：21.1×16.8cm・2kg以内・郵便ポストに入る厚さ'},
 {name:'ゆうパケット',dimensions:'3辺合計60cm以内・長辺34cm以内・厚さ3cm以内・1kg以内'},
] as const;
export function sellerDefaults(task:DeliveryTask):SellerDraft{
 const name=task.deliverer_name||'',yahoo=task.sales_channel==='ヤフオク';
 const postal=/吉光|コエル/.test(name),ishikawa=/石川/.test(name),kubota=/久保田/.test(name),doi=/土井/.test(name),shinkawa=/新川/.test(name);
 const origin=ishikawa?'山梨県':kubota?'愛媛県':doi?'新潟県':/コエル/.test(name)?'埼玉県':shinkawa||/吉光/.test(name)?'千葉県':'';
 const dropoff=postal?'ローソン':ishikawa?'ヤマト営業所':kubota||doi||shinkawa?'セブンイレブン':'';
 const listing=task.description?.match(/^商品名（(?:メルカリ|ヤフオク)）\r?\n([\s\S]*?)\r?\n\r?\n説明文\r?\n([\s\S]*)$/);
 const title=[task.title,task.model_no].filter(Boolean).join(' ');
 const category=/ブルーレイ|blu.?ray|BDZ-|DMR-|DBR-|BD-|2B-|4B-/i.test(title)?'ブルーレイレコーダー':/テレビ|TV|液晶テレビ/i.test(title)?'テレビ':/モニター|モニタ|ディスプレイ/i.test(title)?'モニター':'小物';
 const maker=/SONY|ソニー|BDZ-/i.test(title)?'ソニー':/Panasonic|パナソニック|DMR-/i.test(title)?'パナソニック':/SHARP|シャープ|(?:2B|4B|BD)-/i.test(title)?'シャープ':/TOSHIBA|東芝|DBR-/i.test(title)?'東芝':/三菱|MITSUBISHI/i.test(title)?'三菱電機':'';
 const listingCategory=yahoo&&category==='ブルーレイレコーダー'&&maker?`${category} > ${maker}`:category==='小物'?(/ヘッドホン|ヘッドフォン|headphone/i.test(title)?'ヘッドホン':/イヤホン|earphone/i.test(title)?'イヤホン':/リモコン/.test(title)?'リモコン':/スピーカー/.test(title)?'スピーカー':/アンプ/.test(title)?'アンプ':''):category==='モニター'?'ディスプレイ・モニター':category;
 return {title:listing?.[1]||task.title,description:listing?.[2]||task.description||'',price:Math.ceil((task.planned_price||0)*(yahoo?(task.condition==='可'?.2:.35):.8)),
 condition:!task.condition?'':yahoo?task.condition==='可'?'傷や汚れあり':'やや傷や汚れあり':task.condition==='可'?'全体的に状態が悪い':task.condition==='良い'?'やや傷や汚れあり':'目立った傷や汚れなし',
 shippingMethod:yahoo?(postal?'おてがる配送（日本郵便）':'おてがる配送（ヤマト運輸）'):postal?'ゆうゆうメルカリ便':'らくらくメルカリ便',shippingPayer:yahoo?'購入者負担':'出品者負担',dispatchDays:'2〜3日',origin,category,listingCategory,weightKg:yahoo?(category==='小物'?'2':'5'):undefined,size:category==='ブルーレイレコーダー'?'100':category==='テレビ'||category==='モニター'?'140':'',dropoff,auctionDays:3,closingHour:23,autoExtend:true,autoRelist:false};
}
