const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../apps/admin/public/sw.js'),'utf8');
async function verify(scope,existing){
 const handlers={},shown=[],opened=[],navigated=[];
 const client={url:scope,navigate:async url=>navigated.push(url),focus:async()=>{}};
 const self={registration:{scope,showNotification:async(title,options)=>shown.push({title,options})},skipWaiting(){},addEventListener:(type,fn)=>handlers[type]=fn,
 clients:{claim:async()=>{},matchAll:async()=>existing?[client]:[],openWindow:async url=>opened.push(url)}};
 vm.runInNewContext(source,{self,URL});
 let waiting;const id='61892662-9437-4d89-8926-348ed017e954';
 handlers.push({data:{json:()=>({body:'【2198】動作不良の報告が届きました。',kind:'malfunction',itemId:id})},waitUntil:p=>waiting=p});await waiting;
 assert.equal(shown[0].title,'管理アプリ');assert.equal(shown[0].options.data.itemId,id);
 const destinations=existing?navigated:opened;
 for(const kind of ['malfunction','action','photo_review','invoice','receipts']){
  handlers.notificationclick({notification:{data:{kind,itemId:id,taskId:id,invoiceStaffId:id,billingMonth:'2026-10-01'},close(){}},waitUntil:p=>waiting=p});await waiting;
  const url=new URL(destinations.at(-1));assert.equal(url.origin,new URL(scope).origin);assert.equal(url.pathname,new URL(scope).pathname);
  assert.equal(url.searchParams.get('taskKind'),kind);assert.equal(url.searchParams.get('itemId'),id);
  assert.equal(url.searchParams.get('billingMonth'),'2026-10-01');
  if(kind==='action')assert.equal(url.hash,'#admin-action-'+id);
 }
 handlers.notificationclick({notification:{data:{kind:'https://invalid.example',itemId:'https://invalid.example',billingMonth:'2026-13-01'},close(){}},waitUntil:p=>waiting=p});await waiting;
 assert.equal(destinations.at(-1),scope);
}
(async()=>{await verify('https://bussan-admin.vercel.app/',false);await verify('https://bussan-admin.vercel.app/',true);await verify('https://kazuki101213.github.io/test-repo/admin/',false);console.log('Admin task push display, all task targets, closed/open app, Pages scope and invalid destination checks passed');})().catch(e=>{console.error(e);process.exitCode=1});
