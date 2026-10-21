import {pacedTabs} from './navigation-pacing.js';
import {siteFor} from './core.js';
export async function borrowSiteTab(tabs,site){
 const found=(await tabs.query({})).find(t=>siteFor(t.url)===site&&!t.discarded);
 if(!found)throw Error('画面確認待ち: '+site+'の既存タブがありません。新しいタブは開きません');
 return {id:found.id,originalUrl:found.url,lastUrl:found.url};
}
export async function restoreSiteTab(tabs,borrowed){
 tabs=pacedTabs(tabs);
 if(!borrowed)return;
 const current=await tabs.get(borrowed.id).catch(()=>null);
 if(current?.url===borrowed.lastUrl&&current.url!==borrowed.originalUrl)await tabs.update(borrowed.id,{url:borrowed.originalUrl});
}
