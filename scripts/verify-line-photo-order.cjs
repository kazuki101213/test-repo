const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),assert=require('node:assert/strict');
const source=fs.readFileSync('apps/delivery/src/linePhotoOrder.ts','utf8');const context={exports:{}};
vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,context);
const photos=Array.from({length:9},(_,i)=>({id:String(i+1),url:'fresh-url-'+i}));
const ordered=context.exports.linePhotoOrder(photos,['7','9','8','4','5','6','3','2','1']);
assert.equal(ordered[0].id,'7');assert.equal(ordered[4].id,'5');assert.equal(photos[0].id,'1','source upload order must remain intact');
assert.equal(ordered[0].url,photos[6].url,'must use current URLs, not expired publication URLs');
assert.equal(context.exports.linePhotoOrder(photos,['missing','7','7']).length,9);
assert.equal(context.exports.linePhotoOrder(photos,['7'])[1].id,'1');
assert.equal(context.exports.linePhotoOrder(photos)[0].id,'1');
const component=fs.readFileSync('apps/delivery/src/components/LineShippingSettings.tsx','utf8');
assert(component.includes('linePhotoOrder(await fetchPhotoUrls(itemId),context.photoOrder)'));assert(component.includes('{index+1}枚目'));
console.log('PASS LINE photo order: publication numbering, stable photo IDs, fresh URLs, omitted/deleted photos, upload fallback');

// Exercise the notification state, without sending messages or creating marketplace jobs.
(async()=>{
 let cursor=0,dirty=true,tree,hooks=[],effects=[],timer,reads=0,writes=0,ready=[];
 let response={requiresPhotos:true,photosReady:false,overviewPhotoId:null,modelPhotoId:null,shipping:{},state:'pending',message:'通知写真を指定してください',enabled:true};
 const react={useState(value){const n=cursor++;hooks[n]??={value};return[hooks[n].value,next=>{hooks[n].value=typeof next==='function'?next(hooks[n].value):next;dirty=true;}];},useRef(value){return hooks[cursor++]??={current:value};},useEffect(fn,deps){const n=cursor++,old=hooks[n];if(!old||deps.some((value,i)=>value!==old.deps[i])){effects.push(()=>{old?.cleanup?.();hooks[n]={deps,cleanup:fn()};});}}};
 const jsx=(type,props)=>({type,props}),doc={visibilityState:'visible'};
 const c={exports:{},Date,document:doc,window:{setInterval(fn){timer=fn;return 1;},clearInterval(){timer=null;}},require(name){return name==='react'?react:name==='react/jsx-runtime'?{jsx,jsxs:jsx}:name==='@bussan/shared'?{getSupabase:()=>({rpc:async name=>{if(name!=='line_shipping_context'){writes++;throw Error('Unexpected write');}reads++;return{data:{...response},error:null};}})}:{};}};
 vm.runInNewContext(ts.transpileModule(component,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,c);
 const callback=value=>ready.push(value);
 async function settle(){for(let i=0;i<25;i++){if(dirty){cursor=0;dirty=false;tree=c.exports.default({itemId:'fixture',draft:{},listing:true,onReadyChange:callback});effects.splice(0).forEach(fn=>fn());}await Promise.resolve();}}
 const text=n=>n==null?'':Array.isArray(n)?n.map(text).join(''):typeof n==='object'?text(n.props?.children):String(n);
 await settle();assert.equal(ready.at(-1),false);assert(text(tree).includes('出品前に'));assert(text(tree).includes(response.message));assert.equal(timer,undefined);assert.equal(writes,0);
 // A saved photo selection starts bounded read-only polling; hidden tabs do no work.
 hooks.forEach(h=>h?.cleanup?.());hooks=[];response={...response,photosReady:true,overviewPhotoId:'front',modelPhotoId:'label',message:'LINE通知の準備中です'};dirty=true;
 await settle();assert.equal(ready.at(-1),true);assert.equal(typeof timer,'function');const before=reads;doc.visibilityState='hidden';timer();await settle();assert.equal(reads,before);doc.visibilityState='visible';
 response={...response,state:'sent',message:'LINEへ送信済み'};timer();await settle();assert(text(tree).includes('LINEへ送信済み'));assert.equal(timer,null);assert.equal(writes,0,'Status refresh never resends');hooks.forEach(h=>h?.cleanup?.());
 console.log('PASS LINE readiness: missing-photo warning, listing gate callback, hidden-tab suppression, sent status and polling cleanup without writes');
})().catch(error=>{console.error(error);process.exitCode=1;});
