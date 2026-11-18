const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),assert=require('node:assert/strict');
const jsx=(type,props)=>({type,props});
function all(n,out=[]){if(Array.isArray(n))n.forEach(v=>all(v,out));else if(n&&typeof n==='object'){out.push(n);all(n.props?.children,out)}return out;}
function text(n){return n==null?'':Array.isArray(n)?n.map(text).join(''):typeof n==='object'?text(n.props?.children):String(n);}
const row={id:'fixture',incurred_on:'2026-11-18',category:'配送費',name:'送料',amount:500,card_id:null,staff_id:null,memo:null};
const cards=[{id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',name:'Amazon売上金'},{id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',name:'セゾンカード'}];
async function mount(){
 let hooks=[],cursor=0,effects=[],dirty=true,tree,writes=[],fail=false,cardFail=false,method=null;
 const react={useState(initial){const n=cursor++;hooks[n]??={value:typeof initial==='function'?initial():initial};return[hooks[n].value,v=>{hooks[n].value=typeof v==='function'?v(hooks[n].value):v;dirty=true}]},useRef(value){return hooks[cursor++]??={current:value}},useEffect(fn,deps){const n=cursor++,old=hooks[n];if(!old||deps.some((v,i)=>v!==old.deps[i])){old?.cleanup?.();const entry=hooks[n]={deps};effects.push(()=>entry.cleanup=fn())}}};
 const api={fetchExpenses:async()=>[{...row,card_id:method}],fetchExpenseDrafts:async()=>[],fetchExpenseReimbursements:async()=>[],fetchCards:async purpose=>{assert.equal(purpose,'expense');if(cardFail)throw Error('カードの読込失敗');return cards},updateExpenseField:async(r,f,v)=>{writes.push({field:f,value:v});if(fail)throw Error('保存失敗');method=v||null}};
 const ctx={exports:{},window:{},crypto:{randomUUID:()=> 'request'},require:n=>n==='react'?react:n==='react/jsx-runtime'?{jsx,jsxs:jsx}:n==='@bussan/shared'?{yen:n=>'¥'+n}:n==='../api'?api:n==='../expenses'?{expenseCategories:['配送費'],expenseCategoryLabel:v=>v}:{__esModule:true,default:n}};
 vm.runInNewContext(ts.transpileModule(fs.readFileSync('apps/admin/src/components/ExpenseList.tsx','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText,ctx);
 async function settle(){for(let i=0;i<45;i++){if(dirty){cursor=0;dirty=false;tree=ctx.exports.default({revision:0});effects.splice(0).forEach(fn=>fn())}await Promise.resolve()}}
 await settle();return{nodes:()=>all(tree),settle,writes,setFail:v=>fail=v,setCardFail:v=>cardFail=v};
}
(async()=>{
 const app=await mount(),find=(type,label)=>app.nodes().find(n=>n.type===type&&(n.props['aria-label']===label||text(n)===label));
 const edit=()=>find('button','送料の支払い方法を編集').props.onClick();
 edit();await app.settle();
 assert(find('h3','支払い方法を編集'));
 let select=find('select','支払い方法');assert.equal(select.props.value,'');assert(text(select).includes('Amazon売上金'));assert(text(select).includes('未指定'));
 select.props.onChange({target:{value:cards[0].id}});await app.settle();
 find('button','保存').props.onClick();await app.settle();
 assert.equal(app.writes[0].field,'card_id');assert.equal(app.writes[0].value,cards[0].id);assert.equal(text(find('button','送料の支払い方法を編集')),'Amazon売上金');
 edit();await app.settle();find('button','閉じる').props.onClick();await app.settle();assert.equal(app.writes.length,1);
 edit();await app.settle();find('select','支払い方法').props.onChange({target:{value:''}});await app.settle();
 app.setFail(true);find('button','保存').props.onClick();await app.settle();assert(find('h3','支払い方法を編集'),'Failed save closed editor');assert(app.nodes().some(n=>n.props.role==='alert'&&text(n).includes('保存失敗')));
 app.setFail(false);find('button','保存').props.onClick();await app.settle();assert.equal(text(find('button','送料の支払い方法を編集')),'未指定');
 const code=fs.readFileSync('apps/admin/src/api.ts','utf8').split('export type ExpenseField =')[1].split('export async function moveInventoryAccessoryToSpares')[0];
 let calls=[],changed=false;
 const query={update:v=>{calls.push(['update',v]);return query},eq:(...x)=>{calls.push(['eq',...x]);return query},is:(...x)=>{calls.push(['is',...x]);return query},select:()=>query,maybeSingle:async()=>({data:changed?null:{id:'fixture'},error:null})};
 const ctx={exports:{},getSupabase:()=>({from:name=>{assert.equal(name,'expenses');return query}}),validateExpense:r=>{assert.equal(r.amount,500);assert.equal(r.name,'送料')}};
 vm.runInNewContext(ts.transpileModule('type ExpenseField ='+code,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,ctx);
 await ctx.exports.updateExpenseField(row,'card_id',cards[0].id);assert(calls.some(c=>c[0]==='is'&&c[1]==='card_id'&&c[2]===null));
 calls=[];await ctx.exports.updateExpenseField({...row,card_id:cards[0].id},'card_id','');assert.strictEqual(calls[0][1].card_id,null);assert(calls.some(c=>c[0]==='eq'&&c[1]==='card_id'&&c[2]===cards[0].id));
 changed=true;await assert.rejects(()=>ctx.exports.updateExpenseField(row,'card_id',cards[0].id),/別の画面/);
 console.log('PASS: payment name, selection/save/clear/cancel/error, null-safe and conflict-safe update; no live expense writes');
})().catch(e=>{console.error(e);process.exitCode=1});
