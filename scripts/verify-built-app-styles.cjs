const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const html=fs.readFileSync('apps/delivery/dist/index.html','utf8');
const entry=html.match(/src="([^"]+\.js)"/)[1];
const source=fs.readFileSync('apps/delivery/dist'+entry,'utf8').replace(/export\{[^}]+\};?\s*$/,'');
async function test(mode){
 const links=[];const document={documentElement:{dataset:{}},createElement:()=>({relList:{supports:()=>true},setAttribute(){},addEventListener(type,fn){if(type==='load')queueMicrotask(fn)}}),getElementsByTagName:()=>[],querySelector:()=>null,head:{appendChild:link=>links.push(link)},getElementById:()=>({appendChild(){}})};
 const window={sessionStorage:{getItem:()=>mode},dispatchEvent(){}};
 vm.runInNewContext(source,{document,window,location:{search:'',hash:''},URLSearchParams,Event:class{},Promise,queueMicrotask});
 for(let n=0;n<20;n++)await Promise.resolve();
 const styles=links.filter(x=>x.rel==='stylesheet').map(x=>x.href);
 assert.equal(styles.length,1,mode+' must load exactly one app stylesheet');
 assert(styles[0].includes(mode==='management'?'/assets/main-':'/assets/deliveryEntry-'),mode+' loaded the wrong stylesheet: '+styles[0]);
}
(async()=>{await test('management');await test('delivery');console.log('Production bootstrap preloads each app stylesheet independently')})().catch(e=>{console.error(e);process.exitCode=1});