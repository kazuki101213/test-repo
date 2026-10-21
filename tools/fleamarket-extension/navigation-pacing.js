import {siteFor} from './core.js';

export const NAVIGATION_INTERVAL_MS=8000;
// One queue per worker/profile, shared by purchasing, tracking and seller work.
// Persist only the time; no URLs, account names or credentials are stored.
export function createNavigationPacer({storage,now=Date.now,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}){
 let chain=Promise.resolve(),last=null;
 return action=>{
  const pending=chain.then(async()=>{
   if(last===null){const saved=storage?await storage.get('navigationLastAt'):{};last=Number(saved.navigationLastAt)||0;}
   const delay=Math.min(NAVIGATION_INTERVAL_MS,Math.max(0,last+NAVIGATION_INTERVAL_MS-now()));
   if(delay)await sleep(delay);
   last=now();if(storage)await storage.set({navigationLastAt:last});
   return action();
  });
  chain=pending.catch(()=>{});return pending;
 };
}
let shared;
const wrappers=new WeakMap();
export function paceNavigation(action){
 const pace=shared||(shared=createNavigationPacer({storage:globalThis.chrome?.storage?.local}));
 return pace(action);
}
export function pacedTabs(tabs){
 if(wrappers.has(tabs))return wrappers.get(tabs);
 const pace=paceNavigation;
 const wrapped=new Proxy(tabs,{get(target,key){
  if(key==='update')return async(id,changes)=>{
   if(!changes?.url||!siteFor(changes.url))return target.update(id,changes);
   const before=await target.get(id);
   if(before.url===changes.url)return before;
   return pace(async()=>{
    const current=await target.get(id);
    if(current.url!==before.url)throw Error('画面確認待ち: 待機中にタブが変更されたため停止しました');
    if(current.url===changes.url)return current;
    return target.update(id,changes);
   });
  };
  if(key==='create')return changes=>changes?.url&&siteFor(changes.url)?pace(()=>target.create(changes)):target.create(changes);
  const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
 }});
 wrappers.set(tabs,wrapped);wrappers.set(wrapped,wrapped);return wrapped;
}
