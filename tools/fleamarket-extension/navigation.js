import {siteFor,itemId} from './core.js';
export function allowedSiteRedirect(site,requested,arrived){
 if(siteFor(requested)!==site||siteFor(arrived)!==site)return false;
 const from=new URL(requested),to=new URL(arrived);
 if(/login|signin|auth|captcha/i.test(to.pathname))return false;
 if(site==='rakuma')return from.origin==='https://fril.jp'&&from.pathname==='/transaction'&&/^[a-f0-9]{32}$/.test(from.searchParams.get('item_id')||'')&&to.origin==='https://web.fril.jp'&&to.pathname==='/v2/purchase/item'&&/^[0-9]{1,12}$/.test(to.searchParams.get('item_id')||'');
 if(site==='auctions'){
  const expected=itemId(site,requested);if(!expected||itemId(site,arrived)!==expected)return false;
  const ids=['aID','aid','auctionID','auctionId'].map(k=>to.searchParams.get(k)).filter(Boolean);if(ids.some(id=>id!==expected))return false;
  return to.hostname==='buy.auctions.yahoo.co.jp'&&to.pathname==='/order/status'||to.hostname==='contact.auctions.yahoo.co.jp'&&to.pathname==='/trade/top'||['auctions.yahoo.co.jp','page.auctions.yahoo.co.jp'].includes(to.hostname)&&/^\/(?:jp\/)?auction\/[a-zA-Z][0-9]+\/?$/.test(to.pathname);
 }
 return false;
}
