import {pacedTabs} from './navigation-pacing.js';
import {siteFor} from './core.js';
export async function borrowSiteTab(tabs,site){
 const candidates=(await tabs.query({})).filter(t=>siteFor(t.url)===site&&!t.discarded);
 const found=candidates.find(t=>t.active===false)||candidates[0];
 try{await globalThis.chrome?.storage?.local?.set({lastSiteTabBorrow:{site,at:new Date().toISOString(),candidateCount:candidates.length,inactiveCount:candidates.filter(t=>t.active===false).length,selectedInactive:found?.active===false}});}catch{}

 if(!found)throw Error('画面確認待ち: '+site+'の既存タブがありません。新しいタブは開きません');
 return {id:found.id,originalUrl:found.url,lastUrl:found.url};
}
export async function restoreSiteTab(tabs,borrowed){
 tabs=pacedTabs(tabs);
 if(!borrowed)return;
 const current=await tabs.get(borrowed.id).catch(()=>null);
 if(current?.url===borrowed.lastUrl&&current.url!==borrowed.originalUrl)await tabs.update(borrowed.id,{url:borrowed.originalUrl});
}
