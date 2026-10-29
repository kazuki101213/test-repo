import {catalogProductCategory,productModelText,sellerDefaults,type DeliveryTask} from '@bussan/shared';
import {buildDescription,conditionForTarget,PRODUCT_TYPES,withReportedDamage} from './description';

/** Use the same templates as the description editor; saved edits always win. */
export function listingDraft(task:DeliveryTask,manufacturer:string,listingSkus:string[]=[]){
 const defaults=sellerDefaults({...task,description:withReportedDamage(task.description??'',task.sales_channel==='ヤフオク'&&task.has_physical_damage===true)},manufacturer);
 const template=task.description_template;
 const product=catalogProductCategory(task)??PRODUCT_TYPES.find(value=>value===template)??defaults.category;
 const target=task.sales_channel==='ヤフオク'?'yahoo-auction':task.sales_channel==='メルカリ'?'mercari':'amazon';
 const condition=target==='amazon'?conditionForTarget('amazon',task.condition):defaults.condition;
 const generated=buildDescription({product,target,condition,accessories:task.accessories??'',year:task.manufacture_year?.toString()??'',
  sku:task.sku,listingSkus,itemNumber:task.sku.match(/^(\d+[a-z]*)-/i)?.[1]?.toLowerCase()??String(task.lot_seq),
  modelNo:productModelText(task),manufacturer,hasPhysicalDamage:task.has_physical_damage===true,inspected:task.inspected,cleaned:task.cleaned,salesChannel:task.sales_channel});
 if(target==='amazon')return {...defaults,condition,description:task.description?.trim()?task.description:generated};
 const automatic=sellerDefaults({...task,description:generated},manufacturer);
 const savedChannel=task.description?.match(/^商品名（(メルカリ|ヤフオク)）/)?.[1];
 if(!task.description?.trim()||savedChannel&&savedChannel!==task.sales_channel)return automatic;
 // Older saved descriptions have no title section; retain their body and generate the title.
 return /^商品名（(?:メルカリ|ヤフオク)）\r?\n/.test(task.description)?defaults:{...defaults,title:automatic.title};
}
