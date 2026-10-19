/** Public supplier product links only; never infer a product from an order number. */
export function noticeProductUrl(marketplace:string|null,id:string|null,saved:string|null):string|null{
 const rules:[string[],RegExp,string][]=[
  [['メルカリ'],/^m\d+$/i,'https://jp.mercari.com/item/'],
  [['ヤフオク'],/^[a-z]?\d+$/i,'https://auctions.yahoo.co.jp/jp/auction/'],
  [['ヤフフリ','PayPayフリマ','Yahoo!フリマ'],/^[a-z]\d+$/i,'https://paypayfleamarket.yahoo.co.jp/item/'],
  [['ラクマ'],/^[a-f0-9]{32}$/i,'https://item.fril.jp/'],
 ];
 if(id){const rule=rules.find(([names,pattern])=>names.includes(marketplace||'')&&pattern.test(id));if(rule)return rule[2]+encodeURIComponent(id);}
 if(saved){try{const url=new URL(saved);if(['http:','https:'].includes(url.protocol)&&!url.username&&!url.password)return url.href;}catch{/* Invalid stored links stay plain text. */}}
 return null;
}
