export type Account = 'FBA1' | 'FBA2';
export type Item = {item_id:string; sku:string; asin:string; title:string; condition:string; sales_channel: 'FBA'|Account; published_at?:string};
export type Box = {length:number; width:number; height:number; weight:number; items:string[]};
export type Owner = {prepOwner:'NONE'|'SELLER'; labelOwner:'SELLER'|'NONE'};
export type Charge = {amount:number; code:string};
export type Packing = {id:string; groups:string[]; fees:Charge[]; expiration?:string};
export type Placement = {id:string; shipmentIds:string[]; fees:Charge[]; expiration?:string};
export type Transport = {id:string; shipmentId:string; carrier:string; carrierCode?:string; solution:string; quote?:Charge; expiration?:string; preconditions:string[]};
export type Window = {id:string; start:string; end:string; expiration:string};
export type Shipment = {id:string; confirmationId?:string; warehouse?:string; status:string; trackingSaved?:boolean; boxes?:{id:string; skus:string[]; tracking?:string}[]; received?:Record<string,number>};
export type Stage = 'draft'|'created'|'packing-options'|'packing-confirmed'|'packed'|'placement-options'|'transport-options'|'placement-confirmed'|'ready'|'cancelled';
export type Work = {
 boxes?:Box[]; owners?:Record<string,Owner>; packing?:Packing[]; groups?:Record<string,string>; placements?:Placement[];
 placement?:Placement; transport?:Transport[]; selections?:Transport[]; shipDate?:string;
 windows?:Record<string,Window[]>; selectedWindows?:Record<string,string>; shipments?:Shipment[]; notice?:string;
};
export const canResizeBoxes = (stage:Stage) => stage==='packed' || stage==='placement-options' || stage==='transport-options';
export type Pending = {action:string; at:string; op?:string; boxes?:Box[]; createAfterPrep?:boolean; shipmentId?:string; windowId?:string; tracking?:Record<string,string>; remote?:string};
export type Plan = {id:string; account:Account; name:string; staff_id:string; stage:Stage; revision:number; amazon_id:string|null; pending:Pending|null; work:Work; created_at:string; fba_inbound_items:Item[]};
export const senders = {
 FBA1:{name:'長部一輝',postalCode:'224-0057',stateOrProvinceCode:'神奈川県',city:'横浜市都筑区',addressLine1:'川和町1249-1',addressLine2:'メルヴェイユ2番館204',countryCode:'JP',phoneNumber:'08022407916'},
 FBA2:{name:'石嶋俊紀',postalCode:'333-0861',stateOrProvinceCode:'埼玉県',city:'川口市',addressLine1:'柳崎5-15-24',countryCode:'JP',phoneNumber:'08090332197'},
} as const;
export class WorkflowError extends Error {
 constructor(public status:number,message:string){super(message);}
}
export const invalid = (message:string):never => {throw new WorkflowError(422,message);};
export const uuid = (value:unknown): value is string => typeof value==='string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
export const expired = (date?:string) => !!date && Date.parse(date)<=Date.now();

export function validateBoxes(value:unknown, items:Item[], groups?:Record<string,string>):Box[] {
 if (!Array.isArray(value) || !value.length || value.length>items.length) return invalid('輸送箱を1箱以上登録してください。');
 const expected=new Set(items.map(item=>item.item_id)), seen=new Set<string>();
 const boxes=value.map(box=>{
  if (!box || !Array.isArray(box.items) || !box.items.length || !['length','width','height','weight'].every(k=>typeof box[k]==='number' && Number.isFinite(box[k]) && box[k]>0)) {
   return invalid('各箱に商品を割り当て、寸法と重量を入力してください。');
  }
  const ids:string[]=[];
  for(const id of box.items){
   if(!expected.has(id)||seen.has(id)) return invalid('商品は1点につき1箱にだけ割り当ててください。');
   seen.add(id);ids.push(id);
  }
  if(groups && (ids.some(id=>!groups[id]) || new Set(ids.map(id=>groups[id])).size!==1)) return invalid('Amazonが分けた梱包グループの商品は、別々の箱に入れてください。');
  return {length:box.length,width:box.width,height:box.height,weight:box.weight,items:ids};
 });
 if(seen.size!==expected.size) return invalid('すべての商品を輸送箱に割り当ててください。');
 return boxes;
}
export function transportSelection(value:unknown, placement:Placement, options:Transport[]) {
 if (!Array.isArray(value) || value.length!==placement.shipmentIds.length || expired(placement.expiration)) return invalid('有効な納品先・配送方法を選び直してください。');
 return placement.shipmentIds.map(id=>{
  const candidate=options.find(option=>option.shipmentId===id&&value.includes(option.id));
  if (!candidate || expired(candidate.expiration)) return invalid('納品先ごとに有効な配送方法を1件選択してください。');
  return candidate;
 });
}
export const needsWindow = (option:Transport) => option.solution==='USE_YOUR_OWN_CARRIER' || option.preconditions.includes('CONFIRMED_DELIVERY_WINDOW');
export const unknownPrecondition = (option:Transport) => option.preconditions.find(key=>key!=='CONFIRMED_DELIVERY_WINDOW' && key!=='CONFIRMED_PLACEMENT_REQUIRED');
export const canPublish = (listing:any,item:Item,quantity:unknown,marketplace:string) =>
 typeof quantity==='number' && quantity>0 && Array.isArray(listing?.summaries) &&
 listing.sku===item.sku && listing.summaries.some((s:any)=>s.marketplaceId===marketplace && s.asin===item.asin && Array.isArray(s.status) && s.status.includes('BUYABLE'));
