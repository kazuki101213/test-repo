const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),assert=require('node:assert/strict');
const jsx=(type,props)=>({type,props});
const all=(node,out=[])=>{if(Array.isArray(node))node.forEach(n=>all(n,out));else if(node&&typeof node==='object'){out.push(node);all(node.props?.children,out)}return out};
const text=n=>n==null?'':Array.isArray(n)?n.map(text).join(''):typeof n==='object'?text(n.props?.children):String(n);
let hooks=[],cursor=0,pending=[],dirty=true,tree,requests=[],downloads=[];
const react={useState(initial){const i=cursor++;hooks[i]??={value:typeof initial==='function'?initial():initial};return[hooks[i].value,next=>{const value=typeof next==='function'?next(hooks[i].value):next;if(value!==hooks[i].value){hooks[i].value=value;dirty=true}}]},useEffect(fn,deps){const i=cursor++,old=hooks[i];if(!old||deps.some((v,j)=>v!==old.deps[j])){old?.cleanup?.();const entry=hooks[i]={deps};pending.push(()=>entry.cleanup=fn())}}};
const api={fetchLedger:(from,to)=>new Promise((resolve,reject)=>requests.push({from,to,resolve,reject}))};
const ctx={exports:{},Date,require:name=>name==='react'?react:name==='react/jsx-runtime'?{jsx,jsxs:jsx}:name==='../api'?api:name==='@bussan/shared'?{jpDate:v=>v,yen:v=>v}:name==='../csv'?{downloadCsv:(name,rows)=>downloads.push({name,rows})}:name==='../purchaseUrl'?{purchaseItemUrl:()=>null}:{default:'DateInput'}};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('apps/admin/src/pages/Ledger.tsx','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,ctx);
async function settle(){for(let n=0;n<25;n++){if(dirty){cursor=0;dirty=false;tree=ctx.exports.default();pending.splice(0).forEach(fn=>fn())}await Promise.resolve()}}
const start=()=>all(tree).find(n=>n.props?.['aria-label']==='取引日・開始日');
const csv=()=>all(tree).find(n=>n.type==='button'&&text(n)==='CSV');
(async()=>{await settle();assert.equal(requests.length,1);assert(csv().props.disabled);assert(!all(tree).some(n=>n.type==='button'&&text(n)==='表示'));
start().props.onChange({target:{value:'2020-01-01'}});await settle();start().props.onChange({target:{value:'2020-02-01'}});await settle();assert.equal(requests.length,3,'Date changes fetch without a display button');
const latest={sku:'latest',取引区分:'買受',取引年月日:'2020-02-02',特徴:'latest',品目:'body',数量:1,代価:100};requests[2].resolve([latest]);await settle();assert(!csv().props.disabled);requests[1].resolve([{...latest,sku:'stale'}]);requests[0].resolve([{...latest,sku:'initial'}]);await settle();csv().props.onClick();assert.equal(downloads[0].rows[0].sku,'latest','Old responses must not replace current dates');
start().props.onChange({target:{value:'2020-02-'}});await settle();assert.equal(requests.length,3,'Partial dates must not reach the API');assert(csv().props.disabled);start().props.onChange({target:{value:'2020-02-30'}});await settle();assert.equal(requests.length,3,'Nonexistent dates must not reach the API');
assert(!text(tree).includes('古物営業法施行規則'));assert(!text(tree).includes('住所が未記入'));
console.log('Ledger dates auto-refresh, ignore stale responses, reject partial/invalid dates and export current results only.');})().catch(e=>{console.error(e);process.exitCode=1});
