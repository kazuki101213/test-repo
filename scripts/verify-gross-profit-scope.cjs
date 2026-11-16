const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),assert=require('node:assert/strict');
const compile=file=>ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
const jsx=(type,props)=>({type,props});
function all(n,out=[]){if(Array.isArray(n))n.forEach(v=>all(v,out));else if(n&&typeof n==='object'){out.push(n);all(n.props?.children,out)}return out}
function text(n){return n==null?'':Array.isArray(n)?n.map(text).join(''):typeof n==='object'?text(n.props?.children):String(n)}
const staffNames={exports:{}};vm.runInNewContext(compile('packages/shared/src/staffNames.ts'),staffNames);
const historyMonths=['2026-10','2026-09','2026-08','2026-07','2026-06','2026-05'];
function mount(file,props,mocks){
 let hooks=[],cursor=0,pending=[],dirty=true,tree;
 const react={useState(initial){const n=cursor++;hooks[n]??={value:typeof initial==='function'?initial():initial};return[hooks[n].value,v=>{hooks[n].value=typeof v==='function'?v(hooks[n].value):v;dirty=true}]},useEffect(fn,deps){const n=cursor++,old=hooks[n];if(!old||deps.some((v,i)=>v!==old.deps[i])){old?.cleanup?.();const entry=hooks[n]={deps};pending.push(()=>entry.cleanup=fn())}}};
 const noop=()=>{};const ctx={exports:{},window:{addEventListener:noop,removeEventListener:noop,confirm:()=>true},require:name=>name==='react'?react:name==='react/jsx-runtime'?{jsx,jsxs:jsx}:mocks[name]??{__esModule:true,default:name.split('/').at(-1)}};
 const originalRequire=ctx.require;
 ctx.require=name=>name==='../invoices'?{recentInvoiceMonths:()=>historyMonths,...originalRequire(name)}:originalRequire(name);
 vm.runInNewContext(compile(file),ctx);
 return {get tree(){return tree},async settle(){for(let n=0;n<40;n++){if(dirty){cursor=0;dirty=false;tree=ctx.exports.default(props);pending.splice(0).forEach(fn=>fn())}await Promise.resolve()}}};
}
async function testScope(staff,expectedTarget,canSelect){
 const profiles = [staff, { id:'another', role:'deliverer', name:'別担当者' }].map(person => ({
  staff_id:person.id, details:{issuer_name:person.name}, unit_price:400
 }));
 const view=mount('apps/delivery/src/pages/Invoices.tsx',{staff,onNavigationChange(){}},{
  '@bussan/shared':{...staffNames.exports,invoiceReceiptDetails:()=>[],deliveryStaffOptions:rows=>rows},
  '../invoices':{japanToday:()=> '2026-10-15',invoiceProfiles:async()=>profiles,findInvoice:async()=>null,
   prepareInvoice:async()=>({profile:profiles[0].details,lines:[],tax_percent:0}),
   monthlyGrossProfit:async()=>({rows:[],total:0})},
 });
 await view.settle();
 const nodes=()=>all(view.tree);
 const profit=()=>nodes().find(n=>n.type==='GrossProfitSummary');
 const packed=()=>nodes().find(n=>n.type==='PackedSummary');
 const tablePosition=nodes().find(n=>n.props?.className==='receipt-list-position no-print');
 const panels=nodes().find(n=>n.props?.className?.startsWith('invoice-summaries no-print'));
 assert.equal(panels.props.children[0],tablePosition,'Receipt details occupy the first position');
 assert.equal(panels.props.children[1] || undefined,profit());
 assert.equal(all(panels.props.children[2]).find(n=>n.type==='PackedSummary'),packed());
 const overviewCss=fs.readFileSync('apps/delivery/src/invoice.css','utf8');
 assert.match(overviewCss,/\.invoice-summaries \{[^}]*grid-template-columns:minmax\(0,1fr\)/);
 assert.match(overviewCss,/@media screen and \(min-width:1024px\)\s*\{\s*\.invoice-summaries \{\s*grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
 assert.equal(packed().props.staffId,staff.id);
 assert.equal(packed().props.month,'2026-05');
 assert.equal(packed().props.monthCount,6);
 assert.equal(nodes().find(n=>n.type==='InvoiceReceipts').props.historyMonths,historyMonths);
 if(staff.role==='deliverer'){
  assert.equal(profit(),undefined);
  assert.match(panels.props.className,/invoice-summaries--without-profit/);
  assert.match(overviewCss,/\.invoice-summaries--without-profit \{\s*grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  return;
 }
 assert.equal(profit().props.staffId,expectedTarget);
 assert.equal(profit().props.month,'2026-10');

 nodes().find(n=>n.type==='InvoiceReceipts').props.onBusyChange(false);
 await view.settle();
 const [selector]=nodes().filter(n=>n.type==='select');
 assert.equal(!selector.props.disabled,canSelect);
 if(canSelect){
  nodes().find(n=>n.type==='select').props.onChange({target:{value:'another'}});
  await view.settle();
  assert.equal(profit().props.staffId,'another','The selected invoice assignee drives the report');
  assert.equal(packed().props.staffId,'another');
 }
 nodes().find(n=>n.type==='MonthInput'&&n.props['aria-label']==='請求対象月').props.onChange({target:{value:'2026-09'}});
 await view.settle();
 assert.equal(profit().props.month,'2026-09');

 const calls=[];
 const summary=mount('apps/delivery/src/components/GrossProfitSummary.tsx',profit().props,{
  '@bussan/shared':staffNames.exports,
  '../invoices':{yen:n=>'¥'+n,monthlyGrossProfit:async(target,month)=>{calls.push([target,month]);return{rows:[],total:0}}},
 });
 await summary.settle();
 assert.equal(calls[0][0],canSelect?'another':expectedTarget);
 assert.equal(calls[0][1],'2026-09');
 assert(!all(summary.tree).some(n=>n.type==='select'||n.type==='MonthInput'),'The report has no independent filters');
 assert(all(summary.tree).some(n=>n.type==='h3'&&text(n)==='粗利益'));
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
async function testDashboardPairs(){
 const staff={id:'osabe',code:'AA',name:'長部一輝',role:'admin'}, requests=[];
 const allMonth={month:'2026-11-01',仕入数:6,仕入金額:62000}, ownMonth={month:'2026-11-01',仕入数:3,仕入金額:30000};
 const allStock={現在庫数:5,売上見込み合計:90000,見込み利益合計:20000}, ownStock={現在庫数:2,売上見込み合計:40000,見込み利益合計:8000};
 const dashboard=mount('apps/admin/src/pages/Dashboard.tsx',{staff,userId:'user'},{
  '@bussan/shared':{...staffNames.exports,yen:n=>'¥'+(n??0)},
  '../sales':{japanMonth:()=> '2026-11'},
  '../api':{fetchStockSummary:async()=>allStock,fetchMonthly:async()=>[allMonth],fetchWorkload:async()=>[],workloadMetrics:[],
   fetchDashboardPurchaserSummary:async()=>({stock:ownStock,months:[ownMonth],workload:[]}),
   fetchDashboardPurchaseForecast:async month=>{requests.push(month);return{all:12300,mine:-4500}}},
 });
 await dashboard.settle();
 assert.deepEqual(requests,['2026-11']);
 const pairs=(card)=>all(all(dashboard.tree).find(n=>n.props?.className==='card '+card))
  .filter(n=>typeof n.type==='function'&&n.props.firstLabel)
  .map(n=>all(n.type(n.props)).filter(node=>node.props?.className?.includes('kpi-label')||node.props?.className?.includes('dashboard-money-pair')).map(text));
 assert.deepEqual(pairs('purchase-summary-card'),[['仕入金額 / 見込利益','¥62000/¥12300'],['仕入金額 / 見込利益','¥30000/¥-4500']]);
 assert.deepEqual(pairs('stock-summary-card'),[['見込売上 / 見込利益','¥90000/¥20000'],['見込売上 / 見込利益','¥40000/¥8000']]);
 const stacked=(card)=>all(all(dashboard.tree).find(n=>n.props?.className==='card '+card))
  .filter(n=>typeof n.type==='function'&&n.props.firstLabel)
  .map(n=>Array.from(all(n.type(n.props)).find(node=>node.type==='dl').props.children,row=>Array.from(row.props.children,text)));
 assert.deepEqual(stacked('purchase-summary-card'),[[['仕入金額','¥62000'],['見込利益','¥12300']],[['仕入金額','¥30000'],['見込利益','¥-4500']]]);
 assert.deepEqual(stacked('stock-summary-card'),[[['見込売上','¥90000'],['見込利益','¥20000']],[['見込売上','¥40000'],['見込利益','¥8000']]]);
 assert.match(fs.readFileSync('apps/admin/src/responsive.css','utf8'),/@media screen and \(max-width:1023px\)\s*\{\s*\.dashboard-money-wide \{ display:none; \}\s*\.dashboard-money-stacked \{ display:grid;/);
 assert.match(fs.readFileSync('apps/admin/src/styles.css','utf8'),/\.dashboard-money-pair \{[^}]*flex-wrap:nowrap/);
}
(async()=>{
 await testDashboardPairs();
 await testScope({id:'osabe',code:'AA',name:'長部一輝',role:'admin'},'osabe',true);
 await testScope({id:'ishikawa',code:'EE',name:'石川秀樹',role:'purchaser'},'ishikawa',false);
 await testScope({id:'other-admin',code:'XX',name:'別管理者',role:'admin'},'other-admin',true);
 await testScope({id:'worker',code:'DD',name:'担当者',role:'deliverer'},null,false);
 await testSubmission([],false);await testSubmission([{document_type:'receipt_photo',include_in_invoice:true,spent_on:'2026-10-01'}],true);await testSubmission([{document_type:'invoice'}],false);
 console.log('Gross profit owner scope/administrator selector and combined invoice-receipt submission passed');
})().catch(e=>{console.error(e);process.exitCode=1});
