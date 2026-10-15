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
const api={exports:{},URL:{},require:()=>({})};vm.runInNewContext(compile('packages/shared/src/receipts.ts'),api);
assert.equal(api.exports.invoiceReceiptDetails([...rows,{...receipt('excluded',900),include_in_invoice:false},{...receipt('legacy',100),spent_on:null}]).length,6);
async function testReceiptEditor(){
 let hooks=[],cursor=0,pending=[],dirty=true,tree,stored=[],uploaded,edited;
 const react={useState(initial){const n=cursor++;hooks[n]??={value:typeof initial==='function'?initial():initial};return[hooks[n].value,v=>{hooks[n].value=typeof v==='function'?v(hooks[n].value):v;dirty=true}]},useRef(v){return hooks[cursor++]??={current:v}},useEffect(fn,deps){const n=cursor++,old=hooks[n];if(!old||deps.some((v,i)=>v!==old.deps[i])){old?.cleanup?.();const entry=hooks[n]={deps};pending.push(()=>entry.cleanup=fn())}}};
 const noop=()=>{};const props={staffId:'worker',month:'2026-10',approved:false,onBusyChange:noop,onRowsChange:noop,onCountChange:noop,onChanged:noop,onPrint:noop};
 const component={exports:{},window:{confirm:()=>true},require:name=>name==='react'?react:name==='react/jsx-runtime'?{jsx,jsxs:jsx}:name==='@bussan/shared'?{
  loadInvoiceReceipts:async()=>stored,releaseReceiptImages:noop,
  uploadInvoiceReceipt:async(staff,month,file,type,details)=>{uploaded={staff,month,file,type,details};stored=[{...receipt('registered',details.amount),...details,version:1,original_name:file.name}]},
  updateInvoiceReceipt:async(row,details)=>{edited={row,details};stored=[{...row,...details,version:2}]},removeInvoiceReceipt:noop,
 }:{__esModule:true,default:'DateInput'}};
 vm.runInNewContext(compile('apps/delivery/src/components/InvoiceReceipts.tsx'),component);
 async function settle(){for(let n=0;n<30;n++){if(dirty){cursor=0;dirty=false;tree=component.exports.default(props);pending.splice(0).forEach(fn=>fn())}await Promise.resolve()}}
 const control=label=>{const node=all(tree).find(n=>n.type==='label'&&typeof n.props.children?.[0]==='string'&&n.props.children[0]===label);assert(node,label);return all(node).find(n=>n.type==='input'||n.type==='DateInput')};
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
 function draftControl(label){const draft=all(tree).find(n=>n.props?.className==='invoice-extra invoice-extra-draft');return all(all(draft).find(n=>n.type==='label'&&n.props.children[0]===label)).find(n=>n.type==='input'||n.type==='DateInput')}
 render();
 for(const [label,value]of [['内容','手当'],['数量','2'],['金額','1200']]){draftControl(label).props.onChange({target:{value}});render()}
 assert.equal(changed,0,'Typing a draft must not change the invoice');assert.equal(lines.length,0);
 all(tree).find(n=>n.type==='button'&&text(n)==='追加').props.onClick();render();
 assert.equal(lines.length,1);assert.equal(lines[0].quantity*lines[0].unit_price,2400);assert.equal(draftControl('内容').props.value,'');assert(all(tree).some(n=>n.type==='button'&&text(n)==='削除'));
 all(tree).find(n=>n.type==='button'&&text(n)==='削除').props.onClick();render();
 assert.equal(lines.length,0);assert.equal(all(tree).filter(n=>n.props?.className==='invoice-extra invoice-extra-draft').length,1);assert.equal(draftControl('金額').props.value,'');
 all(tree).find(n=>n.type==='button'&&text(n)==='追加').props.onClick();assert.equal(lines.length,0,'Blank drafts must not be added');
}

(async()=>{
 testExtraRows();
 await testReceiptEditor();
 const {PDFDocument}=require('../packages/shared/node_modules/pdf-lib');
 const source=await PDFDocument.create();source.addPage([420,595]);source.addPage([842,595]);const bytes=await source.save();
 const ctx={exports:{},document:{fonts:{ready:Promise.resolve()}},fetch:async()=>({ok:true,arrayBuffer:async()=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)}),require:name=>name==='pdf-lib'?require('../packages/shared/node_modules/pdf-lib'):name==='html2canvas'?{__esModule:true,default:()=>{throw Error('PDF should not be rasterized')}}:{}};
 vm.runInNewContext(compile('packages/shared/src/invoicePdf.ts'),ctx);
 const merged=await PDFDocument.load(await ctx.exports.buildInvoicePdf([],rows.filter(row=>row.document_type==='receipt')));
 assert.equal(merged.getPageCount(),2);assert.deepEqual(merged.getPages().map(p=>[p.getWidth(),p.getHeight()]),[[420,595],[842,595]]);
 assert(merged.catalog.has(require('../packages/shared/node_modules/pdf-lib').PDFName.of('Names')),'Original PDF should also be embedded');
 console.log('Invoice add/delete draft behavior, receipt save/include, tax-inclusive total, body quantity, 4-photo pages and original PDFs passed');
})().catch(e=>{console.error(e);process.exitCode=1});