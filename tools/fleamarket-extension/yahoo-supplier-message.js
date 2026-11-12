// The function is injected into an existing, account-verified Yahoo buyer tab.
export function inspectYahooSupplierPage({expectedId, openMessages = false}) {
  const origin = 'https://contact.auctions.yahoo.co.jp';
  const idPattern = /^(?:[a-zA-Z]\d+|\d{10})$/;
  const text = element => (element.innerText || element.getAttribute('aria-label') || '').replace(/\s+/g, '').trim();
  const visible = element => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
  const trade = (href, paths) => {
    const url = new URL(href, location.href);
    const id = url.searchParams.get('aid') || url.searchParams.get('aID') || url.searchParams.get('auctionID');
    return url.origin === origin && paths.includes(url.pathname) && idPattern.test(id || '') ? {id, url:url.href} : null;
  };
  const topPaths = ['/buyer/top','/trade/top'];
  const messagePaths = [...topPaths,'/trade/message','/trade/messages','/buyer/message','/buyer/messages'];
  const current = trade(location.href,[...messagePaths,'/trade/bundle','/buyer/bundle']);
  if (current?.id !== expectedId) return {error:'ヤフオク取引ナビの商品IDが一致しません'};
  if (document.querySelector('input[type=password],input[autocomplete=one-time-code]')) return {error:'ログインまたは追加認証が必要です'};
  const mains = [...document.querySelectorAll('main')].filter(visible);
  if (mains.length !== 1) return {error:'ヤフオク取引ナビの表示領域を確認できません'};
  const main = mains[0];
  const links = [...main.querySelectorAll('a[href]')].filter(visible);
  const dialogLinks = [...document.querySelectorAll('[role=dialog] a[href],dialog[open] a[href]')].filter(visible);
  const unique = entries => [...new Map(entries.map(entry => [entry.id,entry])).values()];
  const parent = unique([...links,...dialogLinks].filter(link => text(link)==='まとめて取引を確認する')
    .map(link=>trade(link.href,topPaths)).filter(entry=>entry && entry.id!==expectedId));
  if (parent.length>1) return {error:'まとめて取引の代表を1件に確認できません'};
  const bundle = [...new Set(links.filter(link=>text(link)==='まとめて取引する商品を見る'||text(link)==='まとめて取引する商品')
    .map(link=>trade(link.href,['/trade/bundle','/buyer/bundle'])).filter(entry=>entry?.id===expectedId).map(entry=>entry.url))];
  const itemIds = [...new Set(links.map(link => {
    const url = new URL(link.href);
    if (url.protocol!=='https:' || !['auctions.yahoo.co.jp','page.auctions.yahoo.co.jp'].includes(url.hostname)) return null;
    const id=url.pathname.split('/auction/')[1]?.split('/')[0];
    return idPattern.test(id||'') ? id : null;
  }).filter(Boolean))];
  if (openMessages) {
    if (parent.length || /この商品を含めたまとめて取引に同意|まとめて取引に含まれている商品/.test(text(main))) {
      return {error:'代表の取引ナビを開いてからメッセージを確認してください'};
    }
    const controls=[...main.querySelectorAll('a,button,[role=tab]')]
      .filter(el=>visible(el)&&['メッセージ','取引メッセージ'].includes(text(el)));
    const urls=[...new Set(controls.filter(el=>el.matches('a[href]'))
      .map(el=>trade(el.href,messagePaths)).filter(entry=>entry?.id===expectedId).map(entry=>entry.url))];
    if(urls.length===1 && urls[0]!==current.url) return {messageUrl:urls[0]};
    if(controls.length!==1 || urls.length>1) return {error:'取引メッセージのタブを確認できません'};
    const control=controls[0];
    if(control.matches('a[href]') && urls.length!==1) return {error:'取引メッセージのリンク先が一致しません'};
    if(control.matches('button[type=submit]')||control.closest('form')||control.disabled) return {error:'取引メッセージの閲覧ボタンを確認できません'};
    if(!control.matches('a[href]')) { setTimeout(()=>control.click(),0); return {changing:true}; }
    return {};
  }
  const isBundleList=/\/(?:trade|buyer)\/bundle$/.test(location.pathname);
  return {parent:parent[0]||null,bundleUrl:bundle.length===1?bundle[0]:null,itemIds:isBundleList?itemIds:[],
    isChild:/この商品を含めたまとめて取引に同意|まとめて取引に含まれている商品/.test(text(main))};
}

export async function openYahooSupplierMessages({itemId,navigate,inspect,settle}) {
  const child = await inspect(itemId);
  if (child.isChild && !child.parent) throw Error('まとめて取引の代表を確認できません');
  const destination = child.parent?.id || itemId;
  if (child.parent) {
    let bundleUrl=child.bundleUrl;
    if (!bundleUrl) {
      await navigate(child.parent.url);
      bundleUrl=(await inspect(destination)).bundleUrl;
    }
    if (!bundleUrl) throw Error('まとめて取引の商品一覧を確認できません');
    await navigate(bundleUrl);
    const proof=await inspect(child.bundleUrl?itemId:destination);
    if (!proof.itemIds.includes(itemId)||!proof.itemIds.includes(destination)) {
      throw Error('返品商品と代表商品が同じまとめて取引にあることを確認できません');
    }
    await navigate(child.parent.url);
  }
  const message=await inspect(destination,true);
  if (message.messageUrl) await navigate(message.messageUrl);
  else if (message.changing) await settle(destination);
  return destination;
}
