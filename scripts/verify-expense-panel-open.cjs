const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),assert=require('node:assert/strict');
const jsx=(type,props)=>({type,props});
function all(n,out=[]){if(Array.isArray(n))n.forEach(v=>all(v,out));else if(n&&typeof n==='object'){out.push(n);all(n.props?.children,out)}return out;}
function text(n){return n==null?'':Array.isArray(n)?n.map(text).join(''):typeof n==='object'?text(n.props?.children):String(n);}
async function mount(file,props={},mobile=true){let hooks=[],cursor=0,pending=[],dirty=true,tree,scrolls=0,writes=0;
const react={useState(initial){const n=cursor++;hooks[n]??={value:typeof initial==='function'?initial():initial};return[hooks[n].value,v=>{hooks[n].value=typeof v==='function'?v(hooks[n].value):v;dirty=true}]},useRef(value){return hooks[cursor++]??={current:value}},useEffect(fn,deps){const n=cursor++,old=hooks[n];if(!old||deps.some((v,i)=>v!==old.deps[i])){old?.cleanup?.();const entry=hooks[n]={deps};pending.push(()=>entry.cleanup=fn())}}};
const api={fetchExpenses:async()=>[],fetchExpenseDrafts:async()=>[{id:'draft',category:'固定費',name:'家賃',card_id:null,target_month:'2026-10-01'}],fetchCards:async()=>[],saveExpense:async()=>{writes++;throw Error('Unexpected write')},updateExpense:async()=>{writes++;throw Error('Unexpected write')},updateExpenseField:async()=>{writes++;throw Error('Unexpected write')}};
const mocks={exports:{},crypto:{randomUUID:()=> 'sample'},window:{matchMedia:()=>({matches:mobile})},require:name=>name==='react'?react:name==='react/jsx-runtime'?{jsx,jsxs:jsx}:name==='@bussan/shared'?{yen:n=>'¥'+n}:name==='../api'?api:name==='../expenses'?{expenseCategories:['固定費','変動費','外注費'],expenseCategoryLabel:v=>v}:{__esModule:true,default:name.split('/').at(-1)}};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText,mocks);
async function settle(){for(let i=0;i<30;i++){if(dirty){cursor=0;dirty=false;tree=mocks.exports.default(props);for(const n of all(tree))if(n.props.ref)n.props.ref.current={scrollIntoView(){scrolls++}};pending.splice(0).forEach(fn=>fn())}await Promise.resolve()}}
await settle();return {nodes:()=>all(tree),settle,writes:()=>writes,scrolls:()=>scrolls};}
(async()=>{
const app=await mount('apps/admin/src/components/ExpenseList.tsx',{revision:0});
const panel=()=>app.nodes().find(n=>n.type==='ExpensePanel');
assert(panel(),'Registration form is always visible');
assert.equal(panel().props.onClose,undefined);
assert(!app.nodes().some(n=>n.type==='button'&&text(n)==='経費登録'),'No toggle button');
app.nodes().find(n=>n.props['aria-label']==='家賃の金額と日付を入力').props.onClick();await app.settle();
assert.equal(panel().props.template.month,'2026-10');
assert.equal(panel().props.template.name,'家賃');
panel().props.onBusyChange(true);await app.settle();panel().props.onClose();await app.settle();assert(panel().props.template,'Busy draft remains');
panel().props.onBusyChange(false);await app.settle();panel().props.onClose();await app.settle();assert(panel());assert.equal(panel().props.template,undefined);assert.equal(app.writes(),0);
const form=await mount('apps/admin/src/components/ExpensePanel.tsx',{onSaved(){},onBusyChange(){}});
assert.equal(form.scrolls(),0,'Always-visible mobile form does not force page scroll');
assert(form.nodes().some(n=>n.type==='button'&&text(n)==='経費登録'));
const draft=await mount('apps/admin/src/components/ExpensePanel.tsx',{onSaved(){},onBusyChange(){},template:{id:'draft',month:'2026-10',name:'家賃',category:'固定費',card_id:null}});
assert.equal(draft.scrolls(),1,'Selecting a draft brings the form into view');
assert.equal(form.writes(),0);console.log('PASS: persistent registration, no toggle or initial scroll, draft selection and busy guard, no writes');
})().catch(e=>{console.error(e);process.exitCode=1});
