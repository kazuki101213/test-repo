/** Inventory backgrounds and labels deliberately follow different rules. */
export const INVENTORY_BOX_COLORS = { normal:'#fbf8f0', working:'#fff6d9', listed:'#e8f2e3', listed15:'#fbe9d9', listed30:'#f5dfdd', returned:'#e4eef9', sold:'#e8e8e8' } as const;
export function inventoryAge(date: string | null | undefined, now = new Date()): number | null {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const ms=Date.parse(date+'T00:00:00Z');
  if (!Number.isFinite(ms)||new Date(ms).toISOString().slice(0,10)!==date) return null;
  const today=new Date(now.getTime()+9*3600000).toISOString().slice(0,10);
  return Math.floor((Date.parse(today+'T00:00:00Z')-ms)/86400000);
}
export function inventoryBoxColor(status:string, purchasedAt?:string|null, now?:Date):string {
  const c=INVENTORY_BOX_COLORS;
  if(status==='販売済')return c.sold;
  if(status==='返品処理')return c.returned;
  const age=inventoryAge(purchasedAt,now);
  if(age===null||age<0)return c.normal;
  if(['受取前','検品中','商品登録前','動作不良','Amazon返品依頼','Amazon返送依頼','Amazon補填申請中'].includes(status))return age>=7?c.working:c.normal;
  if(status==='出品中')return age>=30?c.listed30:age>=15?c.listed15:c.listed;
  return c.normal;
}
export type InventoryLabelStyle={backgroundColor:string;color:string};
const tone=(backgroundColor:string,color:string):InventoryLabelStyle=>({backgroundColor,color});
export function inventoryStatusStyle(status:string):InventoryLabelStyle {
  if(['受取前','検品中','商品登録前'].includes(status))return tone('#fff6d9','#78601b');
  if(['出品中','取引中'].includes(status))return tone('#dce9d3','#456439');
  if(status==='動作不良')return tone('#f8dfc8','#91572a');
  if(status==='返品処理')return tone('#dce7f1','#3c6085');
  if(['Amazon返品依頼','Amazon返送依頼','Amazon補填申請中'].includes(status))return tone('#eadcec','#78507d');
  return tone('#e6e4df','#63615b');
}
export const inventoryStatusText=(status:string)=>status==='Amazon返送依頼'?'Amazon返品依頼':status;
export const INVENTORY_ACCESSORY_STYLE=tone('#dce7f1','#3c6085');
export function inventoryStaffStyle(value:string|null|undefined):InventoryLabelStyle {
  const name=(value??'').replace(/\s/g,'').replace(/^[A-Z]{2}/,'');
  const colors:Record<string,InventoryLabelStyle>={長部一輝:tone('#e4f0fc','#365d83'),久保田ゆかり:tone('#e8f0dc','#45662b'),石川秀樹:tone('#efe5f6','#694184'),石川秀櫢:tone('#efe5f6','#694184'),新川水紀:tone('#fae9d8','#854a1d'),久保田真由:tone('#f8e2eb','#843655'),株式会社コエル:tone('#f8f2d6','#706016'),株式会社吉光:tone('#dff0eb','#275e55'),土井花菜:tone('#f7d9d2','#894b41')};
  return colors[name]??tone('#eeeeee','#5b5b5b');
}
export function inventorySiteStyle(value:string|null|undefined):InventoryLabelStyle {
  const site=(value??'').replace(/[12１２]$/,'');
  if(/Amazon|FBA|自己発送/i.test(site))return tone('#f4e1bd','#83571f');
  if(site==='ヤフオク')return tone('#f4e9b6','#756018');
  if(site==='メルカリ')return tone('#f4d8df','#8c4358');
  if(site==='ラクマ')return tone('#e6dcf4','#6f4c90');
  if(['ヤフフリ','PayPayフリマ'].includes(site))return tone('#f8dfcf','#925a34');
  return tone('#eeeeee','#5b5b5b');
}
export function inventorySerial(item:{sku?:string|null;lot_seq?:number}):string {return item.sku?.match(/^(\d+[a-z]*)(?:[-_]|$)/i)?.[1]?.toLowerCase()??String(item.lot_seq??'');}
export function isSeparateAccessory(item:{is_accessory:boolean;sku?:string|null;lot_seq?:number}):boolean {return item.is_accessory&&/^\d+c+$/i.test(inventorySerial(item));}
export const accessoryDisplayLabel=(item:{is_accessory:boolean;sku?:string|null;lot_seq?:number})=>isSeparateAccessory(item)?'付属品(別販売)':'付属品';
/** No fallback between Amazon accounts; ambiguous/unsupported channels stay disabled. */
export function inventoryAmazonAccount(channel:string|null|undefined):'amazon-1'|'amazon-2'|null {
  if(!channel)return null;
  if(/^(?:Amazon|FBA|自己発送)(?:[1１])?$/.test(channel))return 'amazon-1';
  if(/^(?:Amazon|FBA|自己発送)[2２]$/.test(channel))return 'amazon-2';
  return null;
}
