import type {DeliveryTask} from './types';
export type InventoryAction='return_request_complete'|'return_request_cancel'|'inspection_complete'|'inspection_cancel'|'report'|'report_cancel'|'send_back'|'supplier_check'|'supplier_return_complete'|'supplier_return_cancel'|'return_impossible'|'yahoo_instruction'|'yahoo_instruction_cancel'|'compensation_complete'|'compensation_denied'|'listing_complete'|'listing_cancel'|'trade_cancel'|'resell';
export type ProductPanel='photos'|'packingPhotos'|'description'|'messages'|'comments'|'listing'|'shipping';
export interface WorkflowButton {key:InventoryAction|ProductPanel;label:string;note?:boolean;confirmation?:string}
export const isAmazonReturn=(task:Pick<DeliveryTask,'marketplace'>)=>task.marketplace==='Amazon返品'||task.marketplace==='動作品Amazon返品';
export const canAddPackingPhotos=(task:Pick<DeliveryTask,'status'|'sales_channel'>)=>task.sales_channel==='FBA' ? task.status==='商品登録前' : ['自己発送','ヤフオク','メルカリ'].includes(task.sales_channel??'')&&task.status==='出品中';
/** The selected inventory tab never controls an individual product's commands. */
export function deliveryWorkflowButtons(task:DeliveryTask):WorkflowButton[]{
 if(task.is_accessory&&!/^\d+[a-z]*c-/i.test(task.sku))return [];
 const amazon=isAmazonReturn(task);
 switch(task.status){
 case 'Amazon返送依頼':return [{key:'return_request_complete',label:'返送依頼済みにする'}];
 case '検品中':return [{key:'inspection_complete',label:'検品完了'},{key:'report',label:amazon?'破損報告':'動作不良',note:true},...(amazon?[{key:'return_request_cancel' as const,label:'返送依頼取消'}]:[])];
 case '商品登録前':return [
  {key:'photos',label:'写真'},{key:'description',label:'説明文'},
  ...(canAddPackingPhotos(task)?[{key:'packingPhotos' as const,label:'梱包写真'}]:[]),
  ...(task.sales_channel==='メルカリ'||task.sales_channel==='ヤフオク'?[{key:'listing' as const,label:'出品'}]:task.sales_channel==='FBA'||task.sales_channel==='自己発送'?[{key:'listing_complete' as const,label:'出品完了'}]:[]),
  ...(task.workflow_decision==='yahoo'?[{key:'yahoo_instruction_cancel' as const,label:'販売不可取消'}]:!task.workflow_decision?[{key:'inspection_cancel' as const,label:'検品完了取消'}]:[])];
 case '出品中':return [...(canAddPackingPhotos(task)?[{key:'packingPhotos' as const,label:'梱包写真'}]:[]),...(task.seller_message_attention?[{key:'messages' as const,label:'取引メッセージを確認'}]:[]),{key:'listing_cancel',label:'出品完了取消',note:true,confirmation:'実際に出品されていないことを確認しましたか？ サイトの出品は取り下げません。'}];
 case '取引中':return [...(task.sales_channel==='メルカリ'||task.sales_channel==='ヤフオク'?[{key:'shipping' as const,label:'発送済み'},{key:'messages' as const,label:task.seller_message_attention?'取引メッセージを確認':'取引メッセージ'}]:[]),{key:'trade_cancel',label:'キャンセル',note:true,confirmation:'アプリ内だけを出品中へ戻します。サイトのキャンセル手続きは行いません。'},{key:'resell',label:'再販売する',note:true,confirmation:'購入者からの返品を確認し、商品登録前へ戻します。'}];
 case '動作不良':return [{key:'comments',label:'仕入担当者とのメッセージ'},{key:'report_cancel',label:'動作不良取消'},...(task.supplier_contact_requested_at?[{key:'messages' as const,label:'取引メッセージ'},{key:'supplier_return_complete' as const,label:'返品完了',confirmation:'仕入先への返品が完了しましたか？'},{key:'return_impossible' as const,label:'返品不可'}]:[])];
 case '返品処理':return amazon?[]:[{key:'supplier_return_cancel',label:'返品完了取消'}];
 default:return [];
 }
}
export function managementWorkflowButtons(status:DeliveryTask['status']):WorkflowButton[]{
 return status==='Amazon補填申請中'?[{key:'send_back',label:'差し戻し'},{key:'compensation_complete',label:'補填完了'},{key:'compensation_denied',label:'補填却下'}]:status==='動作不良'?[{key:'send_back',label:'差し戻し'},{key:'supplier_check',label:'仕入先確認'},{key:'yahoo_instruction',label:'ヤフオク販売指示'}]:[];
}
