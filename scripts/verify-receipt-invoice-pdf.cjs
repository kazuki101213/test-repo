const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),assert=require('node:assert/strict');
const compile=file=>ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
const jsx=(type,props)=>({type,props});
const money=value=>'¥'+value.toLocaleString('ja-JP');
const context={exports:{},require:name=>name==='react/jsx-runtime'?{jsx,jsxs:jsx}:name==='../invoices'?{yen:money}:{} };
vm.runInNewContext(compile('apps/delivery/src/components/InvoiceSheet.tsx'),context);
function all(n,out=[]){if(Array.isArray(n))n.forEach(v=>all(v,out));else if(n&&typeof n==='object'){out.push(n);all(n.props?.children,out)}return out}
function text(n){return n==null?'':Array.isArray(n)?n.map(text).join(''):typeof n==='object'?text(n.props?.children):String(n)}
const receipt=(id,amount,type='receipt_photo')=>({id,original_name:id+'.pdf',spent_on:'2026-10-01',description:'資材費',amount,mime_type:type==='receipt'?'application/pdf':'image/jpeg',document_type:type,url:'blob:'+id,include_in_invoice:true});
const rows=Array.from({length:5},(_,i)=>receipt(String(i),1100));rows.push(receipt('pdf',2200,'receipt'));
const sheet=context.exports.default({snapshot:{profile:{},lines:[{date:'2026-10-01',description:'ブルーレイレコーダー',quantity:1,unit_price:1000}],tax_percent:10},month:'2026-10',issued:'2026-10-14',extras:[],note:'',receipts:rows});
assert(text(sheet).includes('¥8,800'));assert(text(sheet).includes('消費税：¥100'));assert(text(sheet).includes('立替経費（税込）：¥7,700'));
assert.equal(all(sheet).find(n=>n.type==='tfoot').props.children.props.children[1].props.children,1,'Receipt rows must not add delivery quantity');
const photos={exports:{},require:name=>name==='react/jsx-runtime'?{jsx,jsxs:jsx}:{} };vm.runInNewContext(compile('apps/delivery/src/components/ReceiptSheets.tsx'),photos);
const tree=photos.exports.default({rows,month:'2026-10',name:'Test'});const pages=all(tree).filter(n=>n.props?.className==='receipt-photo-sheet');assert.equal(pages.length,2);assert.equal(all(pages[0]).filter(n=>n.type==='img').length,4);assert.equal(all(pages[1]).filter(n=>n.type==='img').length,1);assert.equal(all(tree).filter(n=>n.type==='img').length,5,'PDFs must not become images');

const profileFields={issuer_name:'氏名保持',postal:'100-0000',address:'住所保持',phone:'000-0000-0000',email:'sample@example.com',recipient:'請求先保持',bank:'銀行名保持',branch:'支店名保持',bank_code:'0000',branch_code:'001',account_type:'普通',account_number:'1234567',holder:'口座名義保持',holder_kana:'メイギカナ'};
const manyExtras=Array.from({length:45},(_,i)=>({date:'2026-10-01',description:'明細保持'+i,quantity:1,unit_price:1000}));
const manySheet=context.exports.default({snapshot:{profile:profileFields,lines:[],tax_percent:10},month:'2026-10',issued:'2026-10-15',extras:manyExtras,note:'備考保持',receipts:[]});
assert(all(manySheet).filter(n=>n.props?.className==='invoice-sheet').length>1);assert.equal(all(manySheet).filter(n=>n.type==='tfoot').length,1,'Totals belong only on the final page');
for(const line of manyExtras)assert(text(manySheet).includes(line.description));const allFieldsText=text(manySheet)+all(manySheet).filter(n=>typeof n.type==='function').map(n=>text(n.type(n.props))).join('');for(const value of Object.values(profileFields))assert(allFieldsText.includes(value),value);assert(text(manySheet).includes('備考保持'));assert(text(manySheet).includes('¥49,500'));
const longExtras=Array.from({length:8},(_,i)=>({date:null,description:i+'長い明細を省略しない'.repeat(18),quantity:1,unit_price:1000}));
const longSheet=context.exports.default({snapshot:{profile:profileFields,lines:[],tax_percent:10},month:'2026-10',issued:'2026-10-15',extras:longExtras,note:'',receipts:[]});
assert(all(longSheet).filter(n=>n.props?.className==='invoice-sheet').length>1);for(const line of longExtras)assert(text(longSheet).includes(line.description));
const longReceipts=Array.from({length:12},(_,i)=>({...receipt('long-'+i,100),description:'長い領収書の内容'.repeat(20),payee:'長い支払先'.repeat(30)}));
const receiptPages=photos.exports.default({rows:longReceipts,month:'2026-10',name:'Test'});
const summaries=all(receiptPages).filter(n=>n.props?.className==='receipt-summary-sheet');assert(summaries.length>1);
const numbers=summaries.flatMap(page=>all(page).filter(n=>n.type==='tbody').flatMap(body=>all(body).filter(n=>n.type==='tr').map(row=>row.props.children[0].props.children)));
assert.deepEqual(numbers,Array.from({length:12},(_,i)=>i+1),'Receipt numbers continue across variable-length pages');

const api={exports:{},URL:{},require:()=>({})};vm.runInNewContext(compile('packages/shared/src/receipts.ts'),api);
assert.equal(api.exports.invoiceReceiptDetails([...rows,{...receipt('excluded',900),include_in_invoice:false},{...receipt('legacy',100),spent_on:null}]).length,6);
async function testReceiptEditor(){
 let hooks=[],cursor=0,pending=[],dirty=true,tree,stored=[],uploaded,edited;
 const react={useState(initial){const n=cursor++;hooks[n]??={value:typeof initial==='function'?initial():initial};return[hooks[n].value,v=>{hooks[n].value=typeof v==='function'?v(hooks[n].value):v;dirty=true}]},useRef(v){return hooks[cursor++]??={current:v}},useEffect(fn,deps){const n=cursor++,old=hooks[n];if(!old||deps.some((v,i)=>v!==old.deps[i])){old?.cleanup?.();const entry=hooks[n]={deps};pending.push(()=>entry.cleanup=fn())}}};
 const noop=()=>{};const props={staffId:'worker',month:'2026-10',approved:false,tableTarget:{},onBusyChange:noop,onRowsChange:noop,onCountChange:noop,onChanged:noop,onPrint:noop};
 const component={exports:{},window:{confirm:()=>true},require:name=>name==='react'?react:name==='react-dom'?{createPortal:child=>child}:name==='react/jsx-runtime'?{jsx,jsxs:jsx}:name==='@bussan/shared'?{
  loadInvoiceReceipts:async()=>stored,releaseReceiptImages:noop,
  uploadInvoiceReceipt:async(staff,month,file,type,details)=>{uploaded={staff,month,file,type,details};stored=[{...receipt('registered',details.amount),...details,version:1,original_name:file.name}]},
  updateInvoiceReceipt:async(row,details)=>{edited={row,details};stored=[{...row,...details,version:2}]},removeInvoiceReceipt:noop,
 }:{__esModule:true,default:'DateInput'}};
 vm.runInNewContext(compile('apps/delivery/src/components/InvoiceReceipts.tsx'),component);
 async function settle(){for(let n=0;n<30;n++){if(dirty){cursor=0;dirty=false;tree=component.exports.default(props);pending.splice(0).forEach(fn=>fn())}await Promise.resolve()}}
 const control=label=>{const node=all(tree).find(n=>n.type==='label'&&typeof n.props.children?.[0]==='string'&&text(n.props.children[0])===label);assert(node,label);return all(node).find(n=>n.type==='input'||n.type==='DateInput')};
 await settle();
 control('日付').props.onChange({target:{value:'2026-10-01'}});await settle();
 control('内容').props.onChange({target:{value:'梱包資材'}});await settle();
 control('金額').props.onChange({target:{valueAsNumber:1100}});await settle();
 all(tree).find(n=>n.type==='input'&&n.props.type==='file'&&!n.props.capture).props.onChange({target:{files:[{name:'photo.jpg',type:'image/jpeg'}]}});await settle();
 all(tree).find(n=>n.type==='form').props.onSubmit({preventDefault(){}});await settle();
 assert.equal(uploaded.staff,'worker');assert.equal(uploaded.month,'2026-10');assert.equal(uploaded.details.amount,1100);assert.equal(uploaded.details.spent_on,'2026-10-01');assert.equal(uploaded.details.description,'梱包資材');assert.equal(uploaded.details.include_in_invoice,true);stored[0].include_in_invoice=false;assert(text(tree).includes('¥1,100'));
 all(tree).find(n=>n.type==='button'&&text(n)==='編集').props.onClick();await settle();control('金額').props.onChange({target:{valueAsNumber:1200}});await settle();all(tree).find(n=>n.type==='form').props.onSubmit({preventDefault(){}});await settle();assert.equal(edited.row.version,1);assert.equal(edited.details.amount,1200);assert.equal(edited.details.include_in_invoice,true,'Saving a receipt must include it in the invoice');assert(text(tree).includes('¥1,200'));
}
function testExtraRows(){
 let hooks=[],cursor=0,lines=[],changed=0,tree;
 const react={useState(initial){const n=cursor++;if(!(n in hooks))hooks[n]=typeof initial==='function'?initial():initial;return[hooks[n],v=>{hooks[n]=typeof v==='function'?v(hooks[n]):v}]} };
 const ctx={exports:{},require:name=>name==='react'?react:name==='react/jsx-runtime'?{jsx,jsxs:jsx}:{__esModule:true,default:'DateInput'}};
 vm.runInNewContext(compile('apps/delivery/src/components/InvoiceExtraRows.tsx'),ctx);
 function render(){cursor=0;tree=ctx.exports.default({lines,disabled:false,onChange:value=>{lines=value;changed++},onDraftChange(){}})}
 function draftControl(label){const draft=all(tree).find(n=>n.props?.className==='invoice-extra invoice-extra-draft');return all(all(draft).find(n=>n.type==='label'&&text(n.props.children[0])===label)).find(n=>n.type==='input'||n.type==='DateInput')}
 render();
 for(const [label,value]of [['内容','手当'],['数量','2'],['金額','1200']]){draftControl(label).props.onChange({target:{value}});render()}
 assert.equal(changed,0,'Typing a draft must not change the invoice');assert.equal(lines.length,0);
 all(tree).find(n=>n.type==='button'&&text(n)==='保存').props.onClick();render();
 assert.equal(lines.length,1);assert.equal(lines[0].quantity*lines[0].unit_price,2400);assert.equal(draftControl('内容').props.value,'');assert(all(tree).some(n=>n.type==='button'&&text(n)==='削除'));
 all(tree).find(n=>n.type==='button'&&text(n)==='削除').props.onClick();render();
 assert.equal(lines.length,0);assert.equal(all(tree).filter(n=>n.props?.className==='invoice-extra invoice-extra-draft').length,1);assert.equal(draftControl('金額').props.value,'');
 all(tree).find(n=>n.type==='button'&&text(n)==='保存').props.onClick();assert.equal(lines.length,0,'Blank drafts must not be added');
}

(async()=>{
 testExtraRows();
 await testReceiptEditor();
 const {PDFDocument}=require('../packages/shared/node_modules/pdf-lib');
 const source=await PDFDocument.create();source.addPage([420,595]);source.addPage([842,595]);const bytes=await source.save();
 const dependencyLoads=[];
 const ctx={exports:{},document:{fonts:{ready:Promise.resolve()}},fetch:async()=>({ok:true,arrayBuffer:async()=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)}),require:name=>{dependencyLoads.push(name);return name==='pdf-lib'?require('../packages/shared/node_modules/pdf-lib'):name==='html2canvas'?{__esModule:true,default:()=>{throw Error('PDF should not be rasterized')}}:{}}};
 vm.runInNewContext(compile('packages/shared/src/invoicePdf.ts'),ctx);
 assert(dependencyLoads.includes('pdf-lib')&&dependencyLoads.includes('html2canvas'),'PDF dependencies must load with the app, before a later deployment can remove old lazy chunks');
 const merged=await PDFDocument.load(await ctx.exports.buildInvoicePdf([],rows.filter(row=>row.document_type==='receipt')));
 assert.equal(merged.getPageCount(),2);assert.deepEqual(merged.getPages().map(p=>[p.getWidth(),p.getHeight()]),[[420,595],[842,595]]);
 assert(merged.catalog.has(require('../packages/shared/node_modules/pdf-lib').PDFName.of('Names')),'Original PDF should also be embedded');
 console.log('Invoice add/delete draft behavior, receipt save/include, tax-inclusive total, body quantity, 4-photo pages and original PDFs passed');
})().catch(e=>{console.error(e);process.exitCode=1});
// Month selection must retain its native YYYY-MM value and disabled/required behavior.
{
 const monthRef={current:null}; let selected,opened=0;
 const ctx={exports:{},require:name=>name==='react'?{useRef:()=>monthRef}:name==='react/jsx-runtime'?{jsx,jsxs:jsx}:{}};
 vm.runInNewContext(compile('apps/delivery/src/components/MonthInput.tsx'),ctx);
 const props={'aria-label':'請求対象月',value:'2026-10',required:true,disabled:false,onChange:e=>selected=e.target.value};
 const monthTree=ctx.exports.default(props);
 const input=all(monthTree).find(n=>n.type==='input');
 assert.equal(input.props.type,'month');assert.equal(input.props.value,'2026-10');assert.equal(input.props.required,true);
 assert.equal(input.props['aria-label'],'請求対象月');assert(text(monthTree).includes('2026-10'));
 input.props.onChange({target:{value:'2026-11'}});assert.equal(selected,'2026-11');
 monthRef.current={showPicker:()=>opened++};
 all(monthTree).find(n=>n.type==='button').props.onClick();assert.equal(opened,1);
 const locked=ctx.exports.default({...props,disabled:true});
 assert.equal(all(locked).find(n=>n.type==='input').props.disabled,true);
 const button=all(locked).find(n=>n.type==='button');assert.equal(button.props.disabled,true);button.props.onClick();assert.equal(opened,1);
 monthRef.current={focus:()=>opened++};
 all(ctx.exports.default(props)).find(n=>n.type==='button').props.onClick();assert.equal(opened,2);
}
