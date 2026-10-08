const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');const compile=f=>ts.transpileModule(fs.readFileSync(path.join(root,f),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const original={id:'spare',title:'リモコン',manufacturer:'Panasonic純正',owner_staff_id:'EE',owner_name:'EE 石川 秀樹',source_sku:'2392-EEMM-0-150',usage_note:'1647リモコン / 1723リモコン / 1765aリモコン',used_for_item_id:null,purchased_at:'2026-05-26'};
let writes=[];const shared={getSupabase:()=>({from(table){let result={data:table==='staff'?[{id:'EE',code:'EE',name:'石川秀樹'}]:[{...original}],error:null};const q={select(){return q;},is(){return q;},eq(){return q;},order(){return q;},range(){return q;},in(){return q;},insert(value){writes.push(value);result={data:null,error:null};return q;},update(value){writes.push(value);result={data:{id:'spare'},error:null};return q;},maybeSingle(){return Promise.resolve(result);},then(resolve,reject){return Promise.resolve(result).then(resolve,reject);}};return q;}})};
const names={exports:{}};vm.runInNewContext(compile('packages/shared/src/staffNames.ts'),names);
const spares={exports:{},Intl,require:id=>id==='./staffNames'?names.exports:shared};vm.runInNewContext(compile('packages/shared/src/spares.ts'),spares);
const shipping={exports:{},require:id=>id==='./spares'?spares.exports:shared};vm.runInNewContext(compile('packages/shared/src/spareShipping.ts'),shipping);
const api={exports:{},require:id=>id==='@bussan/shared'?{...shared,...spares.exports}:{}};vm.runInNewContext(compile('apps/admin/src/api.ts'),api);
const jsx=(type,props)=>({type,props});function all(n,out=[]){if(!n||typeof n!=='object')return out;if(Array.isArray(n)){n.forEach(v=>all(v,out));return out;}out.push(n);all(n.props?.children,out);return out;}function text(n){return n==null?'':Array.isArray(n)?n.map(text).join(''):typeof n==='object'?text(n.props?.children):String(n);}
(async()=>{
 const rows=await spares.exports.fetchSpareAccessories();assert.equal(rows[0].usage_note,'1647 / 1723 / 1765a');assert.equal(rows[0].title,'リモコン');assert.equal(original.usage_note,'1647リモコン / 1723リモコン / 1765aリモコン');
 assert.equal((await shipping.exports.fetchSpareShippingTasks())[0].usage_note,rows[0].usage_note);
 await api.exports.createSpareAccessory(original);assert.equal(writes.at(-1).usage_note,rows[0].usage_note);assert.equal(writes.at(-1).title,'リモコン');
 await api.exports.updateSpareAccessory('spare','usage_note','1765aaリモコン');assert.equal(writes.at(-1).usage_note,'1765aa');
 await api.exports.updateSpareAccessory('spare','title','リモコン');assert.equal(writes.at(-1).title,'リモコン');
 assert.equal(spares.exports.usageRecordText(null),null);assert.equal(spares.exports.usageRecordText('1647蓋'), '1647蓋');
 const spareSearch={exports:{}};vm.runInNewContext(compile('packages/shared/src/spareSearch.ts'),spareSearch);
 let cursor=0,hooks=[],pending=[],dirty=true,tree;
 const react={useState(v){const n=cursor++;if(!hooks[n])hooks[n]={value:v};return[hooks[n].value,next=>{hooks[n].value=next;dirty=true;}];},useEffect(fn,deps){const n=cursor++;if(!hooks[n]||deps.some((v,i)=>v!==hooks[n].deps[i])){hooks[n]={deps};pending.push(fn);}}};
 const ctx={exports:{},require:id=>id==='react'?react:id==='react/jsx-runtime'?{jsx,jsxs:jsx}:id==='@bussan/shared'?{...spares.exports,...names.exports,...spareSearch.exports,canViewDeliveryAssignee:()=>false,yen:x=>String(x)}:{},window:{setInterval(){},clearInterval(){},addEventListener(){},removeEventListener(){}},document:{visibilityState:'visible',addEventListener(){},removeEventListener(){}}};
 vm.runInNewContext(compile('apps/delivery/src/pages/Spares.tsx'),ctx);for(let i=0;i<20;i++){if(dirty){cursor=0;dirty=false;tree=ctx.exports.default({staff:{id:'EE',code:'EE',role:'purchaser'}});pending.splice(0).forEach(fn=>fn());}await Promise.resolve();}
 const rendered=text(tree);assert(rendered.indexOf('保管担当者：')<rendered.indexOf('メーカー：Panasonic純正'));assert(rendered.indexOf('メーカー：Panasonic純正')<rendered.indexOf('購入日：'));assert(rendered.includes('利用記録：1647 / 1723 / 1765a'));assert(!rendered.includes('1647リモコン'));
 console.log('Shared spare/shipping reads and usage saves remove only リモコン; delivery manufacturer appears between owner and purchase date');
})().catch(e=>{console.error(e);process.exitCode=1;});
