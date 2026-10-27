import {itemId} from './core.js';
export function deferredReceiptItem(job,account,error){
 if(job?.kind!=='receipt'||job.stage!=='detail'||job.pendingReceipt||error?.message!=='取引の商品IDを1件に確定できません')return null;
 try{return itemId(account.site,job.urls?.[job.index]);}catch{return null;}
}
