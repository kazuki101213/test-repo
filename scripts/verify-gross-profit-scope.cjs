const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),assert=require('node:assert/strict');
const compile=file=>ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
const jsx=(type,props)=>({type,props});
function all(n,out=[]){if(Array.isArray(n))n.forEach(v=>all(v,out));else if(n&&typeof n==='object'){out.push(n);all(n.props?.children,out)}return out}
function text(n){return n==null?'':Array.isArray(n)?n.map(text).join(''):typeof n==='object'?text(n.props?.children):String(n)}
const staffNames={exports:{}};vm.runInNewContext(compile('packages/shared/src/staffNames.ts'),staffNames);
function mount(file,props,mocks){
 let hooks=[],cursor=0,pending=[],dirty=true,tree;
 const react={useState(initial){const n=cursor++;hooks[n]??={value:typeof initial==='function'?initial():initial};return[hooks[n].value,v=>{hooks[n].value=typeof v==='function'?v(hooks[n].value):v;dirty=true}]},useEffect(fn,deps){const n=cursor++,old=hooks[n];if(!old||deps.some((v,i)=>v!==old.deps[i])){old?.cleanup?.();const entry=hooks[n]={deps};pending.push(()=>entry.cleanup=fn())}}};
 const noop=()=>{};const ctx={exports:{},window:{addEventListener:noop,removeEventListener:noop,confirm:()=>true},require:name=>name==='react'?react:name==='react/jsx-runtime'?{jsx,jsxs:jsx}:mocks[name]??{__esModule:true,default:name.split('/').at(-1)}};
 vm.runInNewContext(compile(file),ctx);
 return {get tree(){return tree},async settle(){for(let n=0;n<40;n++){if(dirty){cursor=0;dirty=false;tree=ctx.exports.default(props);pending.splice(0).forEach(fn=>fn())}await Promise.resolve()}}};
}
async function testScope(staff,expectedTarget,canSelect){
 const calls=[],people=[{id:'ishikawa',name:'石川秀樹',role:'purchaser'},{id:'osabe',name:'長部一輝',role:'admin'}];let queries=0;
 const q={select(){return q},eq(){return q},in(){return q},order:async()=>({data:people,error:null})};
 const view=mount('apps/delivery/src/components/GrossProfitSummary.tsx',{staff},{'@bussan/shared':{...staffNames.exports,getSupabase:()=>{queries++;return{from:()=>q}}},'../invoices':{japanToday:()=> '2026-10-15',yen:n=>'¥'+n,monthlyGrossProfit:async(target,month)=>{calls.push([target,month]);return{rows:[],total:0}}}});
 await view.settle();assert.equal(calls.at(-1)[0],expectedTarget);assert.equal(calls.at(-1)[1],'2026-10');
 const selector=all(view.tree).find(n=>n.type==='select');assert.equal(!!selector,canSelect);assert.equal(queries,canSelect?1:0);
 assert(all(view.tree).some(n=>n.type==='h3'&&text(n)==='粗利益'));assert(!text(view.tree).includes('販売日を基準に'));
 if(canSelect){selector.props.onChange({target:{value:'osabe'}});await view.settle();assert.equal(calls.at(-1)[0],'osabe','AA can switch between purchasers')}
}
async function testSubmission(receipts,expectedReceipts){
 const staff={id:'worker',code:'DD',name:'担当者',role:'deliverer'};let sent;
 const profile={staff_id:'worker',details:{issuer_name:'担当者'},unit_price:400};
 const view=mount('apps/delivery/src/pages/Invoices.tsx',{staff,onNavigationChange(){}},{'@bussan/shared':{...staffNames.exports,invoiceReceiptDetails:rows=>rows.filter(row=>row.include_in_invoice),deliveryStaffOptions:rows=>rows},'../invoices':{japanToday:()=> '2026-10-15',invoiceProfiles:async()=>[profile],findInvoice:async()=>null,prepareInvoice:async()=>({profile:profile.details,lines:[{quantity:1,unit_price:400}],tax_percent:0}),submitDocuments:async(...args)=>{sent=args;return null}}});
 await view.settle();all(view.tree).find(n=>n.type==='InvoiceReceipts').props.onRowsChange(receipts);await view.settle();
 all(view.tree).find(n=>n.type==='form'&&n.props.id==='invoice-submit-form').props.onSubmit({preventDefault(){}});await view.settle();
 assert.equal(sent[0],'worker');assert.equal(sent[6],true);assert.equal(sent[7],expectedReceipts,'Invoice send includes registered receipts and skips an empty receipt submission');
 assert(!text(view.tree).includes('領収書送信'));assert(!text(view.tree).includes('保存後、請求書を送信すると反映されます。'));
}
(async()=>{
 await testScope({id:'osabe',code:'AA',name:'長部一輝',role:'admin'},'ishikawa',true);
 await testScope({id:'ishikawa',code:'EE',name:'石川秀樹',role:'purchaser'},'ishikawa',false);
 await testScope({id:'other-admin',code:'XX',name:'別管理者',role:'admin'},'other-admin',false);
 await testScope({id:'worker',code:'DD',name:'担当者',role:'deliverer'},null,false);
 await testSubmission([],false);await testSubmission([{document_type:'receipt_photo',include_in_invoice:true,spent_on:'2026-10-01'}],true);await testSubmission([{document_type:'invoice'}],false);
 console.log('Gross profit owner scope/AA selector and combined invoice-receipt submission passed');
})().catch(e=>{console.error(e);process.exitCode=1});