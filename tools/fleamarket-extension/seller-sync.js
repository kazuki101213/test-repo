/** Pure scheduler: caller must have finished the existing 01:00 purchase/tracking work. */
export function sellerScheduleReady(settings,records,day){
 if(settings.mode==='diagnostic'||records.job||records.sellerDailyAttempt?.day===day)return false;
 return ['tracking',...(settings.purchaseImportEnabled?['purchases']:[])].every(kind=>records.scheduledRuns?.[kind]?.day===day&&records.lastRun?.[kind]?.day===day);
}
export function sellerAccounts(settings){return settings.accounts.filter(account=>account.enabled&&['mercari-1','auctions-1'].includes(account.id));}
export function sellerUrl(account,url){
 const value=new URL(url),hosts=account.site==='mercari'?['jp.mercari.com']:['auctions.yahoo.co.jp','page.auctions.yahoo.co.jp','contact.auctions.yahoo.co.jp','buy.auctions.yahoo.co.jp','salesmanagement.yahoo.co.jp','aucpay.yahoo.co.jp'];
 if(value.protocol!=='https:'||!hosts.includes(value.hostname)||value.username||value.password||/login|signin|captcha|auth\//i.test(value.pathname))throw Error('対象の販売サイトを確認できません');return value.href;
}
export function sellerTarget(rows,context){
 const ids=new Set(context.flatMap(item=>item.external_id?[item.external_id]:[]));
 const serialCounts=new Map();for(const item of context)if(item.serial)serialCounts.set(item.serial,(serialCounts.get(item.serial)||0)+1);
 return rows.filter(row=>ids.has(row.external_id)||row.serial&&serialCounts.get(row.serial)===1);
}
/** Money/date labels refer to the actual transaction detail, never the settlement list date. */
export function parseSellerSaleDetail(channel,text,externalId){
 const s=text.replace(/\s+/g,' ').trim();
 const ids=[...s.matchAll(/商品ID\s*[:：]?\s*([a-z][0-9]+)/gi)].map(value=>value[1].toLowerCase());if(ids.length!==1||ids[0]!==externalId)throw Error('販売明細の商品IDが一致しません');
 const amount=label=>{const match=s.match(new RegExp(label+'\\s*[:：]?\\s*[¥￥]?\\s*([0-9][0-9,]*)\\s*(?:円)?'));if(!match)throw Error(label+'を確認できません');return Number(match[1].replaceAll(',',''));};
 const label=channel==='メルカリ'?'購入日時':'取引日';
 const m=s.match(new RegExp(label+'\\s*[:：]?\\s*(20[0-9]{2})[年/.-]\\s*([0-9]{1,2})[月/.-]\\s*([0-9]{1,2})(?:日)?(?:\\s+([0-9]{1,2})[:：]([0-9]{2}))?'));
 if(!m)throw Error('実際の販売日を確認できません');
 const sold_on=`${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`;
 if(new Date(sold_on+'T00:00:00Z').toISOString().slice(0,10)!==sold_on)throw Error('販売日が不正です');
 return {sold_on,sold_price:amount(channel==='メルカリ'?'商品代金':'決済金額'),payout_amount:amount(channel==='メルカリ'?'販売利益':'受取金額'),trade_key:externalId+':'+sold_on+(m[4]?`T${m[4].padStart(2,'0')}:${m[5]}`:'')};
}
/** Runs inside a merchant tab; every field returned is derived from visible seller-page DOM. */
export function readSellerPage({site,phase=null}={}){
 const norm=value=>(value||'').replace(/\s+/g,' ').trim(),visible=e=>!!e&&e.getClientRects().length>0&&getComputedStyle(e).visibility!=='hidden';
 const root=document.querySelector('main')||document.body,text=norm(root.innerText);
 if(/\/(?:purchases|purchase|won)(\/|$)/.test(location.pathname))throw Error('購入一覧ではなく出品一覧を開いてください');
 if(document.querySelector('input[type="password"],input[autocomplete="one-time-code"]')||/ログインしてください|認証コードを入力|文字認証|ロボットではない|セキュリティチェック/.test(text))throw Error('ログイン・追加認証が必要です。今回の取得を停止しました');
 if(!/出品した商品|出品一覧|出品中|取引中の商品|出品終了分|売上金管理|受け取り一覧|受け取り明細|取引画面|取引情報/.test(text))throw Error('販売側の画面を確認できません');
 const links=[...document.querySelectorAll('a[href]')].filter(visible),idOf=url=>{try{const u=new URL(url,location.href);return site==='mercari'?(u.hostname==='jp.mercari.com'&&u.pathname.match(/\/(?:item|transaction)\/(m[0-9]+)/)?.[1]):u.pathname.match(/\/(?:jp\/)?auction\/([a-z][0-9]+)/i)?.[1]?.toLowerCase()||['aID','aid','auctionID','auctionId'].map(key=>u.searchParams.get(key)).find(value=>/^[a-z][0-9]+$/i.test(value||''))?.toLowerCase();}catch{return null;}};
 const allowed=url=>{try{const u=new URL(url,location.href);return u.protocol==='https:'&&(site==='mercari'?u.hostname==='jp.mercari.com':['auctions.yahoo.co.jp','page.auctions.yahoo.co.jp','contact.auctions.yahoo.co.jp','buy.auctions.yahoo.co.jp','salesmanagement.yahoo.co.jp','aucpay.yahoo.co.jp'].includes(u.hostname));}catch{return false;}};
 const navigation=links.filter(link=>/^(出品中|取引中|売却済み|出品終了分|売上金管理|次へ|次のページ|次)$/.test(norm(link.innerText))&&allowed(link.href)).map(link=>({text:norm(link.innerText),url:link.href}));
 const active=[...document.querySelectorAll('[aria-selected="true"],[aria-current="page"],[aria-pressed="true"],[data-state="active"]')].filter(visible).map(e=>norm(e.innerText)).find(value=>['出品中','取引中','売却済み','出品終了分','売上金管理'].includes(value));
 const effectivePhase=active||phase;
 let itemCount=0;const rows=new Map();
 for(const link of links){const external_id=idOf(link.href);if(!external_id)continue;itemCount++;
  let box=link.closest('tr,li,article,[data-testid="item-cell"],[data-testid="item-container"]')||link;
  for(let parent=box.parentElement,depth=0;parent&&depth<5;parent=parent.parentElement,depth++){
   const body=norm(parent.innerText);const ids=new Set([...parent.querySelectorAll('a[href]')].map(a=>idOf(a.href)).filter(Boolean));
   if(ids.size>1||body.length>5000)break;
   if(/商品を発送して|支払い待ち|支払いをお待ち|チャージ完了|キャンセルが成立|入金期限.*(?:過ぎ|切れ)|取引中|売却済み/.test(body))box=parent;
  }
  const body=norm(box.innerText),serial=body.match(/[【\[]([0-9]+[a-z]*)[】\]]/i)?.[1]?.toLowerCase();
  let status=null;
  if(site==='mercari')status=/キャンセルが成立|取引がキャンセルされました/.test(body)?'キャンセル':/支払い待ち|支払いをお待ち|お支払い待ち/.test(body)?'支払い待ち':effectivePhase==='売却済み'?'販売済':effectivePhase==='取引中'?'取引中':effectivePhase==='出品中'?'出品中':null;
  else status=/チャージ完了/.test(body)?'販売済':/入金期限.*(?:過ぎ|切れ)|取引が中止されました/.test(body)?'キャンセル':/商品を発送して(?:下さい|ください)/.test(body)&&!/落札者なし|落札されませんでした/.test(body)?'取引中':effectivePhase==='出品中'?'出品中':null;
  if(!status)continue;
  const detail=[...box.querySelectorAll('a[href]')].find(a=>allowed(a.href)&&/詳細|取引画面|取引情報|取引ナビ/.test(norm(a.innerText)));
  const trade=[...box.querySelectorAll('a[href]')].find(a=>allowed(a.href)&&/\/transaction\/|\/trade\/|\/order\//.test(a.href));
  const row={external_id,serial,status,trade_key:external_id,url:trade?.href||link.href,detail_url:detail?.href||trade?.href||link.href,attention:/キャンセル|中止/.test(body)};
  const previous=rows.get(external_id);if(previous&&previous.status!==status)throw Error('同じ商品IDに異なる状態があります');rows.set(external_id,row);
 }
 return {itemCount,rows:[...rows.values()],navigation,active:active||null,text,empty:/出品した商品がありません|該当する商品はありません|取引中の商品はありません|売却済みの商品はありません|該当する明細がありません/.test(text)};
}
