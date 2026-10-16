import {SLOTS,siteFor,jstDay} from './core.js';
const lists={mercari:'https://jp.mercari.com/mypage/purchases',auctions:'https://auctions.yahoo.co.jp/my/won',flea:'https://paypayfleamarket.yahoo.co.jp/my/purchase',rakuma:'https://fril.jp/buy'};
export function launcherTabSite(tab){
 const direct=siteFor(tab.url)||siteFor(tab.pendingUrl);if(direct)return direct;
 try{const u=new URL(tab.url);if(u.origin==='https://login.yahoo.co.jp')return siteFor(u.searchParams.get('.done'));}catch{}return null;
}
export async function openLauncherSites(tabs,settings,windowId){
 const accounts=settings.accounts.filter(a=>a.enabled);if(!accounts.length)throw Error('このChromeにはアカウントが登録されていません');
 for(const a of accounts)if(!SLOTS.some(s=>s.id===a.id&&s.site===a.site)||a.listUrl!==lists[a.site]||!a.identity?.text)throw Error('登録済みアカウントの購入一覧を確認できません');
 const opened=[];let created=0,firstTab=null;
 for(const a of accounts){const existing=(await tabs.query({})).find(t=>launcherTabSite(t)===a.site&&!t.discarded);if(!existing){const t=await tabs.create({url:a.listUrl,active:false,...(Number.isInteger(windowId)?{windowId}:{})});if(!firstTab)firstTab=t;created++;}else if(!firstTab)firstTab=existing;opened.push(a.label);}
 if(firstTab?.id&&tabs.update)await tabs.update(firstTab.id,{active:true});
 return {created,reused:opened.length-created,accounts:opened};
}
export function missingTabRecovery(settings,records,events,marks={},now=Date.now()){
 const day=jstDay(now),requests=[],nextMarks={...marks};
 for(const kind of ['purchases','tracking']){if(kind==='purchases'&&!settings.purchaseImportEnabled)continue;
 const r=records.lastRun?.[kind],start=records.scheduledRuns?.[kind];if(!r||r.day!==day||r.manual!==false||start?.day!==day||!r.counts?.errors)continue;
 const begin=Date.parse(start.startedAt),end=Date.parse(r.at);if(!Number.isFinite(begin)||!Number.isFinite(end))continue;
 const ids=settings.accounts.filter(a=>a.enabled&&events.some(e=>e.kind==='error'&&e.account===a.label&&Date.parse(e.at)>=begin&&Date.parse(e.at)<=end&&/既存タブがありません/.test(e.text||''))).map(a=>a.id).filter(id=>!nextMarks[day+':'+kind+':'+id]);
 if(ids.length){requests.push({day,kind,accounts:ids});for(const id of ids)nextMarks[day+':'+kind+':'+id]=true;}
 }
 return {requests,marks:Object.fromEntries(Object.entries(nextMarks).filter(([k])=>k.startsWith(day+':')))};
}

export function desktopRequestApplies(request,profileId,lastId,now=Date.now()){
 if(!request||request.id===lastId||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(request.id||''))return false;
 const created=Date.parse(request.createdAt),expires=Date.parse(request.expiresAt);
 return Number.isFinite(created)&&Number.isFinite(expires)&&created<=now+60000&&expires>now&&expires-created>0&&expires-created<=15*60000&&Array.isArray(request.profiles)&&request.profiles.includes(profileId);
}
