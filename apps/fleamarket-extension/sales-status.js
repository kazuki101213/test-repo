/** Read only the seller list currently displayed. Never infer status from an absent item. */
export function readSellerInventory(){
 const observedAt=new Date().toISOString();
 const channel=location.hostname==='jp.mercari.com'?'メルカリ':/^(auctions|page\.auctions)\.yahoo\.co\.jp$/.test(location.hostname)?'ヤフオク':null;
 if(!channel)throw new Error('メルカリかヤフオクの出品一覧を開いてください');
 const root=document.querySelector('main')||document.body;
 const visible=e=>!!(e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden');
 const norm=s=>(s||'').replace(/\s+/g,' ').trim();
 const heading=norm(root.innerText).slice(0,1800);
 if(!/出品した商品|出品一覧|出品中の商品|取引中の商品|出品終了分|出品中/.test(heading)||/\/(purchases|purchase|won)(\/|$)/.test(location.pathname))throw new Error('購入一覧ではなく、自分の出品一覧を開いてください');
 const selected=[...document.querySelectorAll('[aria-selected="true"],[aria-current="page"],input:checked')].filter(visible).map(e=>norm(e.innerText||e.getAttribute('aria-label')||e.closest('label')?.innerText)).join(' ');
 const explicitState=/(^| )取引中($| )/.test(selected)?'取引中':/(^| )出品中($| )/.test(selected)?'出品中':null;
 const rows=new Map();
 for(const link of root.querySelectorAll('a[href]')){
  if(!visible(link))continue;
  const box=link.closest('li,tr,article,[data-testid="item-cell"],[data-testid="item-container"]')||link;
  const text=norm(box.innerText);
  const match=text.match(/[【\[]([0-9]+[a-z]*)[】\]]/i);
  if(!match)continue;
  const serial=match[1].toLowerCase();
  // Yahoo ended auctions enter transactions only for this specific shipping instruction.
  const status=channel==='メルカリ'&&/支払い待ち|お支払い待ち|支払いをお待ち/.test(text)?'出品中':channel==='ヤフオク'?(/商品を発送して(下さい|ください)/.test(text)?'取引中':explicitState==='出品中'?'出品中':null):(/取引中/.test(text)?'取引中':explicitState);
  if(!status)continue;
  if(rows.has(serial)&&rows.get(serial)!==status)throw new Error('同じ通番号に異なる状態があり、反映を中止しました');
  rows.set(serial,status);
 }
 if(!rows.size)throw new Error('通番号と出品中・取引中を確認できません。対象の一覧タブを開いてください');
 return {channel,observedAt,rows:[...rows].map(([serial,status])=>({serial,status}))};
}
