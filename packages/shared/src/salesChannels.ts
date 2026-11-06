/** Legacy values remain readable while new selections identify the seller account. */
export function salesChannelLabel(value:string|null|undefined):string {
  return value==='FBA'?'FBA1':value==='自己発送'?'自己発送1':value??'';
}
export function isFbaChannel(value:string|null|undefined):boolean { return /^FBA(?:[12１２])?$/.test(value??''); }
export function isSelfShippingChannel(value:string|null|undefined):boolean { return /^自己発送(?:[12１２])?$/.test(value??''); }
export function isAmazonSalesChannel(value:string|null|undefined):boolean { return isFbaChannel(value)||isSelfShippingChannel(value); }
export const AMAZON_CHANNEL_SELLERS = {
  FBA1:'A1WI3OGPE43N2T',FBA2:'A3E7BXJWH9TP11',
  自己発送1:'A1WI3OGPE43N2T',自己発送2:'A3E7BXJWH9TP11',
} as const;
