import type {DeliveryTask} from './types';
import {catalogProductCategory} from './productCategory';
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
export function sellerDefaults(task:DeliveryTask,manufacturer=''):SellerDraft{
 const name=task.deliverer_name||'',yahoo=task.sales_channel==='ヤフオク';
 const postal=/吉光|コエル/.test(name),ishikawa=/石川/.test(name),kubota=/久保田/.test(name),doi=/土井/.test(name),shinkawa=/新川/.test(name);
 const origin=ishikawa?'山梨県':kubota?'愛媛県':doi?'新潟県':/コエル/.test(name)?'埼玉県':shinkawa||/吉光/.test(name)?'千葉県':'';
 const dropoff=postal?'ローソン':ishikawa?'ヤマト営業所':kubota||doi||shinkawa?'セブンイレブン':'';
 const listing=task.description?.match(/^商品名（(?:メルカリ|ヤフオク)）\r?\n([\s\S]*?)\r?\n\r?\n説明文\r?\n([\s\S]*)$/);
 const title=[task.title,task.model_no].filter(Boolean).join(' ');
 const category=catalogProductCategory(task)??(/ブルーレイ|blu.?ray|UBP-|BDP-|BDZ-|DMR-|DBR-|BD-|2B-|4B-/i.test(title)?'ブルーレイレコーダー':/テレビ|TV|液晶テレビ/i.test(title)?'テレビ':/モニター|モニタ|ディスプレイ/i.test(title)?'モニター':'小物');
 const makerText=[manufacturer,title].join(' ').normalize('NFKC');
 const maker=/SONY|ソニー|BDZ-|BDP-S|UBP-X/i.test(makerText)?'ソニー':/Panasonic|パナソニック|DMR-/i.test(makerText)?'パナソニック':/SHARP|シャープ|(?:2B|4B|BD)-/i.test(makerText)?'シャープ':/TOSHIBA|東芝|DBR-/i.test(makerText)?'東芝':/三菱|MITSUBISHI/i.test(makerText)?'三菱電機':'';
 const listingCategory=yahoo&&category==='ブルーレイレコーダー'&&maker?`${category} > ${maker}`:category==='小物'?(/ヘッドホン|ヘッドフォン|headphone/i.test(title)?'ヘッドホン':/イヤホン|earphone/i.test(title)?'イヤホン':/リモコン/.test(title)?'リモコン':/スピーカー/.test(title)?'スピーカー':/アンプ/.test(title)?'アンプ':''):category==='モニター'?'ディスプレイ・モニター':category;
 return {title:listing?.[1]||task.title,description:listing?.[2]||task.description||'',price:Math.ceil((task.planned_price||0)*(yahoo?(task.condition==='可'?.2:.35):.8)),
 condition:!task.condition?'':yahoo?task.condition==='可'?'傷や汚れあり':'やや傷や汚れあり':task.condition==='可'?'全体的に状態が悪い':task.condition==='良い'?'やや傷や汚れあり':'目立った傷や汚れなし',
 shippingMethod:yahoo?(postal?'おてがる配送（日本郵便）':'おてがる配送（ヤマト運輸）'):postal?'ゆうゆうメルカリ便':'らくらくメルカリ便',shippingPayer:yahoo?'購入者負担':'出品者負担',dispatchDays:yahoo?'2〜3日':'4〜7日',origin,category,listingCategory,weightKg:yahoo?(category==='小物'?'2':'5'):undefined,size:category==='ブルーレイレコーダー'?'100':category==='テレビ'||category==='モニター'?'140':'',dropoff,auctionDays:3,closingHour:23,autoExtend:true,autoRelist:false};
}

/** Manufacturer branches cannot be selected using only their parent category. */
export function sellerListingCategoryError(draft:Pick<SellerDraft,'category'|'listingCategory'>,salesChannel:string|null):string{
 return salesChannel==='ヤフオク'&&draft.category==='ブルーレイレコーダー'&&(!draft.listingCategory?.trim()||draft.listingCategory.normalize('NFKC').replace(/\s/g,'')==='ブルーレイレコーダー')
  ?'出品カテゴリはメーカーまで指定してください（例：ブルーレイレコーダー > ソニー）。':'';
}

/** A saved shipping method must never inherit a drop-off from another carrier. */
export function sellerShippingPlaces(method:string):string[]{
 return /日本郵便|ゆうゆう/.test(method)?['ローソン','郵便局']:['ヤマト営業所','セブンイレブン'];
}
export function sellerShippingSizes(method:string):string[]{
 const postal=/日本郵便|ゆうゆう/.test(method);
 return ['100','140',...SMALL_PACKAGES.filter(value=>postal?value.name.startsWith('ゆう'):value.name==='宅急便コンパクト').map(value=>value.name)];
}
export function sellerShippingError(draft:{shippingMethod?:unknown;size?:unknown;dropoff?:unknown}):string{
 if(typeof draft.shippingMethod!=='string'||!draft.shippingMethod)return '配送方法を確認してください';
 if(typeof draft.size!=='string'||!sellerShippingSizes(draft.shippingMethod).includes(draft.size))return '配送方法に対応する配送サイズを選択してください';
 if(typeof draft.dropoff!=='string'||!sellerShippingPlaces(draft.shippingMethod).includes(draft.dropoff))return '配送方法に対応する発送場所を選択してください';
 return '';
}
export function sellerShippingDraft(defaults:SellerDraft,saved:Partial<SellerDraft>|null={}):SellerDraft{
 const draft={...defaults,...(saved??{})},places=sellerShippingPlaces(draft.shippingMethod);
 return {...draft,size:sellerShippingSizes(draft.shippingMethod).includes(draft.size)?draft.size:'',dropoff:places.includes(draft.dropoff)?draft.dropoff:places.includes(defaults.dropoff)?defaults.dropoff:places[0]!};
}
