const fs=require('fs'),vm=require('vm'),assert=require('assert/strict');
const source=fs.readFileSync('tools/fleamarket-extension/sales-status.js','utf8').replace('export function','function');
function scan(channel,tab,texts){
 const element=text=>({innerText:text,getClientRects:()=>[{}],getAttribute:()=>null,closest:()=>null});
 const links=texts.map(text=>{const row=element(text);return {...element(text),closest:()=>row};});
 const main={innerText:'出品した商品 出品中 取引中 出品終了分',querySelectorAll:()=>links};
 const c={Date,Map,Error,location:{hostname:channel==='メルカリ'?'jp.mercari.com':'auctions.yahoo.co.jp',pathname:'/mypage/listings'},document:{body:main,querySelector:()=>main,querySelectorAll:()=>[element(tab)]},getComputedStyle:()=>({visibility:'visible'})};
 vm.runInNewContext(source,c);return JSON.parse(JSON.stringify(c.readSellerInventory()));
}
assert.deepEqual(scan('メルカリ','出品中',['【1272aa】BDZ-ZW1500','[2252b] 2B-C20CW1']).rows,[{serial:'1272aa',status:'出品中'},{serial:'2252b',status:'出品中'}]);
assert.equal(scan('メルカリ','取引中',['【2391】DMR-4W101']).rows[0].status,'取引中');
assert.equal(scan('ヤフオク','出品終了分',['【2398】4B-C20AT3 商品を発送して下さい']).rows[0].status,'取引中');
assert.equal(scan('ヤフオク','出品中',['【2395】BDZ-ZT1700']).rows[0].status,'出品中');
assert.throws(()=>scan('ヤフオク','出品終了分',['【2398】落札されませんでした']));
assert.throws(()=>scan('メルカリ','取引中',['型番のみ・通番号なし']));
console.log('Seller lists: exact suffix serials, transaction tabs, Yahoo shipment instruction and ambiguous/unsold ended exclusion passed');
