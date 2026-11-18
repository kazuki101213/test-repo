import {getSupabase} from './supabase';
export type TaskPurchaseProduct={id:string;parent_item_id:string|null;is_accessory:boolean;sku:string;title:string;marketplace:string|null;marketplace_item_id:string|null;marketplace_url:string|null};
export type TaskPurchaseReferences={purchase_products?:TaskPurchaseProduct[]};
const fields='id,parent_item_id,is_accessory,sku,title,marketplace,marketplace_item_id,marketplace_url';
/** Follow actual inventory ownership; equal serial numbers alone do not prove a relationship. */
export async function withTaskPurchaseProducts<T extends {id:string;item_id?:string}>(tasks:T[]):Promise<(T&TaskPurchaseReferences)[]>{
 if(!tasks.length)return [];
 const sb=getSupabase(),items=new Map<string,TaskPurchaseProduct>();
 async function read(column:string,ids:string[]){
  for(let offset=0;offset<ids.length;offset+=100){
   const batch=ids.slice(offset,offset+100);
   for(let page=0;;page+=500){
    const {data,error}=await sb.from('items').select(fields).in(column,batch).order('id').range(page,page+499);
    if(error)throw error;
    for(const item of data??[])items.set(item.id,item as TaskPurchaseProduct);
    if((data?.length??0)<500)break;
   }
  }
 }
 const ids=[...new Set(tasks.map(task=>task.item_id??task.id))];
 await read('id',ids);
 const roots=[...new Set(ids.flatMap(id=>{const item=items.get(id);return item?[item.parent_item_id??item.id]:[]}))];
 await read('id',roots.filter(id=>!items.has(id)));
 await read('parent_item_id',roots);
 const groups=new Map<string,TaskPurchaseProduct[]>();
 for(const item of items.values()){
  const root=item.parent_item_id??item.id;
  const group=groups.get(root)??[];group.push(item);groups.set(root,group);
 }
 for(const group of groups.values())group.sort((a,b)=>Number(a.is_accessory)-Number(b.is_accessory)||a.sku.localeCompare(b.sku)||a.id.localeCompare(b.id));
 return tasks.map(task=>{const item=items.get(task.item_id??task.id);return {...task,purchase_products:item?groups.get(item.parent_item_id??item.id)??[item]:[]};});
}
