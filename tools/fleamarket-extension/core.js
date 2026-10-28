export const API = 'https://xgoppuqoqeppckyunnvx.supabase.co';
export const PUBLIC_KEY = 'sb_publishable_OU4Hc6ayg0m8Xe8bhV7Ofw_SKjj7bTx';
export const SITES = {
  mercari: {name:'メルカリ', db:['メルカリ'], hosts:['jp.mercari.com'], home:'https://jp.mercari.com/mypage'},
  auctions: {name:'ヤフオク', db:['ヤフオク'], hosts:['auctions.yahoo.co.jp','page.auctions.yahoo.co.jp','contact.auctions.yahoo.co.jp','buy.auctions.yahoo.co.jp'], home:'https://auctions.yahoo.co.jp/my'},
  flea: {name:'Yahoo!フリマ', db:['ヤフフリ','PayPayフリマ'], hosts:['paypayfleamarket.yahoo.co.jp','paypayfleamarket-sec.yahoo.co.jp'], home:'https://paypayfleamarket.yahoo.co.jp/'},
  rakuma: {name:'ラクマ', db:['ラクマ'], hosts:['fril.jp','www.fril.jp','item.fril.jp','web.fril.jp'], home:'https://fril.jp/'}
};
export const SLOTS = [
  ['mercari-1','mercari','メルカリ1'],['mercari-2','mercari','メルカリ2'],
  ['auctions-1','auctions','ヤフオク1'],['auctions-2','auctions','ヤフオク2'],
  ['flea-1','flea','Yahoo!フリマ1'],['flea-2','flea','Yahoo!フリマ2'],['rakuma-1','rakuma','ラクマ1']
].map(([id,site,label])=>({id,site,label,enabled:false}));
export function siteFor(url) {
  try {const u=new URL(url); if(u.protocol!=='https:') return null;
    return Object.keys(SITES).find(key=>SITES[key].hosts.includes(u.hostname)) || null;
  } catch {return null;}
}
export function assertSiteUrl(site,url) {
  if(siteFor(url)!==site) throw new Error('登録サイト以外への移動を停止しました');
  return url;
}
export function itemId(site,url) {
  try {const u=new URL(url); if(siteFor(url)!==site) return null;
    const p=u.pathname;
    if(site==='mercari') return p.match(/\/(?:item|transaction)\/(m\d+)(?:\/|$)/)?.[1] || null;
    if(site==='auctions') return p.match(/\/auction\/((?:[a-zA-Z]\d+|\d{10}))(?:\/|$)/)?.[1] || ['aID','aid','auctionID','auctionId'].map(k=>u.searchParams.get(k)).find(v=>/^(?:[a-zA-Z]\d+|\d{10})$/.test(v||'')) || null;
    if(site==='flea') return p.match(/\/(?:item|transaction)\/([a-zA-Z]\d+)(?:\/|$)/)?.[1] || null;
    if(site==='rakuma') return p.match(/^\/([a-f0-9]{32})(?:\/|$)/)?.[1] || p.match(/\/(?:item|transaction|trade|deal)\/([a-f0-9]{32})(?:\/|$)/)?.[1] || (p==='/transaction'&&/^[a-f0-9]{32}$/.test(u.searchParams.get('item_id')||'')?u.searchParams.get('item_id'):null);
  } catch {return null;}
}
export function trackingNumbers(text) {
  const set=new Set();
  for(const m of text.matchAll(/(?:追跡番号|お問い合わせ番号|お問合せ番号|送り状番号|伝票番号)[：:\s]*([0-9][0-9\s\-－]{6,26}[0-9])/g)) {
    const n=m[1].replace(/[\s\-－]/g,''); if(/^\d{8,20}$/.test(n)) set.add(n);
  }
  return [...set];
}
export function eligible(items,tx) {
  if(tx.role!=='buyer'||tx.state!=='pending') return {ok:false,reason:'購入者側の未完了取引ではありません'};
  if(items.length!==1) return {ok:false,reason:items.length?'在庫ID重複':'在庫未一致'};
  if((!items[0].inspected_at||!items[0].cleaned_at)&&!(items[0].receipt_ready===true&&items[0].receipt_source==='parent'&&typeof items[0].receipt_parent_sku==='string'&&items[0].receipt_parent_sku.length>0)) return {ok:false,reason:'検品・清掃の記録待ち'};
  return {ok:true,sku:items[0].sku};
}
export function jstDay(now=Date.now()) {return new Date(now+9*3600000).toISOString().slice(0,10);}
export function dueTime(hour,now=Date.now()) {return Date.parse(jstDay(now)+'T'+String(hour).padStart(2,'0')+':00:00+09:00');}
export function nextTime(hour,now=Date.now()) {const d=dueTime(hour,now); return d>now?d:d+86400000;}
export function settingsDefault(){return {openNewTabs:false,mode:'diagnostic',trackingHour:1,receiptHour:2,accounts:structuredClone(SLOTS),recipes:{}};}
export function validateSettings(s) {
  if(s.receiptStartDay!==undefined&&(!/^\d{4}-\d{2}-\d{2}$/.test(s.receiptStartDay)||!Number.isFinite(Date.parse(s.receiptStartDay+'T00:00:00Z'))||new Date(s.receiptStartDay+'T00:00:00Z').toISOString().slice(0,10)!==s.receiptStartDay))throw new Error('受取評価の開始日が不正です');
  if(!['diagnostic','tracking','full'].includes(s.mode)) throw new Error('動作モードが不正です');
  for(const key of ['trackingHour','receiptHour']) if(!Number.isInteger(s[key])||s[key]<0||s[key]>23) throw new Error('時刻は0〜23時です');
  if(!Array.isArray(s.accounts)||s.accounts.length!==7) throw new Error('7アカウントの設定が必要です');
  if(s.mode!=='diagnostic'&&!s.accounts.some(a=>a.enabled)) throw new Error('このChromeプロファイルのアカウントを登録してください');
  const seen=new Set(),enabledSites=new Set();
  for(const a of s.accounts){
    if(Object.hasOwn(a,'_identityConfirmed'))throw new Error('一時的なアカウント確認結果は保存できません');
if(a.identity?.pageUrl){
      assertSiteUrl(a.site,a.identity.pageUrl);const page=new URL(a.identity.pageUrl);
      if(page.search||page.hash||!['mercari','flea','rakuma','auctions'].includes(a.site))throw new Error('アカウント確認ページが不正です');
      if(a.site==='rakuma'&&(a.identity.pageUrl!=='https://fril.jp/mypage'||!/^.{1,100}さんのマイページ$/.test(a.identity.text||'')))throw new Error('ラクマのアカウント確認ページが不正です');
      if(a.site==='auctions'&&a.identity.pageUrl!=='https://auctions.yahoo.co.jp/my/won')throw new Error('ヤフオクの落札分で確認してください');
      if(a.site==='mercari'&&page.pathname!=='/mypage/purchases')throw new Error('メルカリの購入一覧で登録してください');
      if(a.site==='flea'&&!/^\/(?:my|mypage)(?:\/|$)/.test(page.pathname))throw new Error('Yahoo!フリマの購入一覧で登録してください');
    }
    const slot=SLOTS.find(x=>x.id===a.id); if(!slot||slot.site!==a.site||seen.has(a.id)) throw new Error('アカウントIDが不正です'); seen.add(a.id);
    if(a.enabled){if(enabledSites.has(a.site)) throw new Error('同じサイトの別アカウントは別Chromeプロファイルに登録してください'); enabledSites.add(a.site);
      assertSiteUrl(a.site,a.listUrl); if(!a.identity?.selector||!a.identity?.text||a.identity.text.length>200) throw new Error('ログイン中アカウントの紐付けが必要です');}
  }
  for(const [site,r] of Object.entries(s.recipes||{})){if(!SITES[site]) throw new Error('サイト設定が不正です');
    if((r.verified||r.trackingEnabled)&&!r.scope) throw new Error('検証済みレシピには対象領域が必要です');
    if(r.receiptWorkflow&&(site!=='auctions'||r.receiptWorkflow!=='yahoo-buyer-contact-v1'||r.receiptScope!=='main'||r.receiptVerified!==true))throw new Error('受取評価の検証済み手順が一致しません');if(r.receiptVerified&&!r.receiptWorkflow&&(!r.receiptScope||!r.positive||!r.submit||!r.submitText||!r.successText)) throw new Error('評価レシピの検証項目が不足しています');
  }
  return s;
}

export function trackingEnabled(recipe){return recipe?.verified===true||recipe?.trackingEnabled===true;}

export function receiptAccounts(settings){
 if(settings.mode==='diagnostic')return [];
 return (settings.accounts||[]).filter(a=>a.enabled&&((settings.mode==='full'&&settings.recipes?.[a.site]?.receiptVerified===true)||(settings.mode==='tracking'&&a.site==='auctions'&&settings.recipes?.auctions?.receiptEnabled===true&&settings.recipes.auctions.receiptVerified===true&&settings.recipes.auctions.receiptWorkflow==='yahoo-buyer-contact-v1')));
}
