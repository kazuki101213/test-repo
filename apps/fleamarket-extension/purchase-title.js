// Standalone site notices and controls are not product titles.
export function validPurchaseTitle(value){
 if(typeof value!=='string')return false;
 const title=value.replace(/\s+/g,' ').trim();
 if(!title||title.length>500)return false;
 const notice=/^(?:(?:新しい|未読の)?(?:取引)?メッセージ(?:があります|あり|が届いています)|取引連絡|取引ナビ|取引画面|評価|評価する|詳細を見る|商品ページへ|商品画像|サムネイル|発送待ち|取引完了|支払い待ち|お支払い待ち|受取連絡待ち)(?:\s*[（(]?\s*[0-9]+件\s*[）)]?)?$/;
 if(notice.test(title))return false;
 if(/^(?:[¥￥]\s*)?[0-9][0-9,]*\s*円?$/.test(title))return false;
 if(/^[0-9]{4}[年./-][0-9]{1,2}[月./-][0-9]{1,2}日?(?:\s+[0-9]{1,2}:[0-9]{2})?$/.test(title))return false;
 return true;
}
