import {productModelText,sellerDefaults,type DeliveryTask} from '@bussan/shared';
import {buildDescription,PRODUCT_TYPES} from './description';

/** Use the same templates as the description editor; saved edits always win. */
export function listingDraft(task:DeliveryTask,manufacturer:string,listingSkus:string[]=[]){
 const defaults=sellerDefaults(task);
 const template=task.description_template;
 const product=PRODUCT_TYPES.find(value=>value===template)??defaults.category;
 const target=task.sales_channel==='ヤフオク'?'yahoo-auction':'mercari';
 const generated=buildDescription({product,target,condition:defaults.condition,accessories:task.accessories??'',year:task.manufacture_year?.toString()??'',
  sku:task.sku,listingSkus,itemNumber:task.sku.match(/^(\d+[a-z]*)-/i)?.[1]?.toLowerCase()??String(task.lot_seq),
  modelNo:productModelText(task),manufacturer,inspected:task.inspected,cleaned:task.cleaned,salesChannel:task.sales_channel});
 const automatic=sellerDefaults({...task,description:generated});
 if(!task.description?.trim())return automatic;
 // Older saved descriptions have no title section; retain their body and generate the title.
 return /^商品名（(?:メルカリ|ヤフオク)）\r?\n/.test(task.description)?defaults:{...defaults,title:automatic.title};
}
