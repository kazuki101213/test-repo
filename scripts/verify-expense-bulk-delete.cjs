const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),assert=require('node:assert/strict');
const compile=f=>ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const jsx=(type,props)=>({type,props});
function all(n,out=[]){if(Array.isArray(n))n.forEach(x=>all(x,out));else if(n&&typeof n==='object'){out.push(n);all(n.props?.children,out)}return out}
function text(n){return n==null?'':Array.isArray(n)?n.map(text).join(''):typeof n==='object'?text(n.props?.children):String(n)}
let rows=[1,2,3].map((id,i)=>({id:String(id),incurred_on:'2099-11-01',category:['固定費','変動費','外注費'][i],name:'経費'+id,amount:id*100,card_id:null,staff_id:null,memo:null}));
let cursor=0,hooks=[],pending=[],dirty=true,tree,calls=[],fail=true,release;
const react={useState(initial){const n=cursor++;hooks[n]??={value:typeof initial==='function'?initial():initial};return[hooks[n].value,v=>{hooks[n].value=typeof v==='function'?v(hooks[n].value):v;dirty=true}]},useRef(v){return hooks[cursor++]??={current:v}},useEffect(fn,deps){const n=cursor++;if(!hooks[n]||deps.some((v,i)=>v!==hooks[n].deps[i])){hooks[n]?.cleanup?.();const h=hooks[n]={deps};pending.push(()=>h.cleanup=fn())}}};
const context={exports:{},Error,window:{matchMedia:()=>({matches:false,addEventListener(){},removeEventListener(){}})},crypto:{randomUUID:()=> 'request'},require:id=>id==='react'?react:id==='react/jsx-runtime'?{jsx,jsxs:jsx}:id==='@bussan/shared'?{yen:n=>'¥'+n}:id==='../expenses'?{expenseCategories:['固定費','変動費','外注費'],expenseCategoryLabel:x=>x}:id==='../api'?{fetchExpenses:async()=>[...rows],fetchExpenseDrafts:async()=>[],deleteExpenses:async(selected,request)=>{calls.push({selected,request});await new Promise(r=>release=r);if(fail)throw Error('通信エラー');rows=rows.filter(row=>!selected.some(s=>s.id===row.id));return selected.length}}:{default:'placeholder'}};
vm.runInNewContext(compile('apps/admin/src/components/ExpenseList.tsx'),context);
async function settle(){for(let i=0;i<20;i++){if(dirty){cursor=0;dirty=false;tree=context.exports.default({revision:0});pending.splice(0).forEach(fn=>fn())}await Promise.resolve()}}
const checks=()=>all(tree).filter(n=>n.type==='input'&&n.props.type==='checkbox');
const remove=()=>all(tree).find(n=>n.type==='button'&&text(n)==='削除');
const confirmation=()=>all(tree).find(n=>n.props?.onDelete&&n.props?.rows);
(async()=>{
 await settle();assert(remove().props.disabled);assert.equal(checks().length,3);assert.equal(calls.length,0);
 checks()[0].props.onChange({target:{checked:true}});checks()[1].props.onChange({target:{checked:true}});await settle();assert(!remove().props.disabled);
 const top=all(tree).find(n=>n.props?.className==='expense-entry-top');assert(!text(top).includes('¥'));assert(all(top).some(n=>n.type==='input'&&n.props.type==='checkbox'));
 const bottom=all(tree).find(n=>n.props?.className==='expense-entry-bottom');assert(text(bottom).includes('固定費'));assert(text(bottom).includes('¥100'));
 remove().props.onClick();await settle();assert.equal(calls.length,0,'Opening confirmation never deletes');assert.equal(confirmation().props.rows.length,2);
 confirmation().props.onClose();await settle();assert(!confirmation());assert.equal(calls.length,0);
 remove().props.onClick();await settle();confirmation().props.onDelete();confirmation().props.onDelete();await settle();assert.equal(calls.length,1,'Double submit is locked');assert(confirmation().props.busy);release();await settle();assert.equal(confirmation().props.error,'通信エラー');assert.equal(checks().filter(n=>n.props.checked).length,2);
 fail=false;confirmation().props.onDelete();await settle();assert.equal(calls[1].request,calls[0].request,'Retry reuses the request ID');release();await settle();assert.equal(checks().length,1);assert(remove().props.disabled);assert(text(tree).includes('2件の経費を削除しました。'));
 checks()[0].props.onChange({target:{checked:true}});await settle();all(tree).find(n=>n.props?.['aria-label']==='経費を検索').props.onChange({target:{value:'経費'}});await settle();assert(remove().props.disabled,'Changing search clears hidden selections');
 const filters=[],rpcCalls=[];let rpcResult={data:2,error:null};
 const query={select(){return query},is(field,value){filters.push([field,value]);return query},order(){return query},gte(){return query},lte(){return query},range:async()=>({data:[],error:null})};
 const apiModule={exports:{},Error,require:id=>id==='@bussan/shared'?{getSupabase:()=>({from:()=>query,rpc:async(name,args)=>{rpcCalls.push({name,args});return rpcResult}})}:id==='./inventory'?{readAllRows:fn=>fn(0,99)}:{}};
 vm.runInNewContext(compile('apps/admin/src/api.ts'),apiModule);
 await apiModule.exports.fetchExpenses();await apiModule.exports.fetchExpenseDrafts();await apiModule.exports.fetchMonthlyDetail('2099-11','expense');
 assert.equal(filters.length,3);assert(filters.every(([field,value])=>field==='deleted_at'&&value===null),'Lists, drafts and monthly details exclude deleted rows');
 assert.equal(await apiModule.exports.deleteExpenses(calls[0].selected,'request'),2);assert.equal(rpcCalls[0].name,'delete_expenses');assert.equal(rpcCalls[0].args.p_request_id,'request');
 rpcResult={data:0,error:null};await assert.rejects(apiModule.exports.deleteExpenses(calls[0].selected,'request'),/削除結果/);
 console.log('Expense selection placement, confirmation/cancel, atomic request, double-click guard, failed retry and list/count refresh passed');
})().catch(e=>{console.error(e);process.exitCode=1});
