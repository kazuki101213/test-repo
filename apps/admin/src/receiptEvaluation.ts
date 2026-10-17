import {buildPurchaseUrl,parsePurchaseUrl} from './purchaseUrl';

/** Use the purchase item ID; never link to the item's later selling transaction. */
export function receiptTransactionUrl(marketplace:string,itemId:string|null,savedUrl:string|null):string|null{
 const source=buildPurchaseUrl(marketplace,itemId??'')??parsePurchaseUrl(savedUrl??'');
 const expected=marketplace==='PayPayフリマ'?'ヤフフリ':marketplace;
 if(!source||source.marketplace!==expected)return null;
 const id=encodeURIComponent(source.itemId);
 switch(expected){
  case 'メルカリ':return 'https://jp.mercari.com/transaction/'+id;
  case 'ヤフオク':return 'https://contact.auctions.yahoo.co.jp/buyer/top?aid='+id;
  case 'ヤフフリ':return 'https://paypayfleamarket.yahoo.co.jp/transaction/'+id;
  case 'ラクマ':return 'https://fril.jp/transaction?item_id='+id;
  default:return null;
 }
}
