const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),assert=require('node:assert/strict');
const jsx=(type,props)=>({type,props});
const all=(node,out=[])=>{if(Array.isArray(node))node.forEach(v=>all(v,out));else if(node&&typeof node==='object'){out.push(node);all(node.props?.children,out)}return out};
const text=node=>node==null?'':Array.isArray(node)?node.map(text).join(''):typeof node==='object'?text(node.props?.children):String(node);
const compile=source=>ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
(async()=>{
 let hooks=[],cursor=0,pending=[],dirty=true,tree,calls=[],approved=0;
 const react={useState(initial){const n=cursor++;hooks[n]??={value:typeof initial==='function'?initial():initial};return[hooks[n].value,v=>{hooks[n].value=typeof v==='function'?v(hooks[n].value):v;dirty=true}]},useRef(value){return hooks[cursor++]??={current:value}},useEffect(fn,deps){const n=cursor++,old=hooks[n];if(!old||deps.some((v,i)=>v!==old.deps[i])){hooks[n]={deps};pending.push(fn)}}};
 const files=[{id:'photo',mime_type:'image/jpeg',document_type:'receipt_photo',url:'blob:loaded-photo'},{id:'pdf',mime_type:'application/pdf',document_type:'receipt',url:'blob:loaded-pdf'}];
 const task={staff_id:'worker',month:'2026-10-01',name:'担当者',receipts:{version:9},invoice:{id:'invoice',version:7,total:1100,issued_on:'2026-11-02',note:'提出済み',snapshot:{profile:{issuer_name:'担当者'},lines:[],extras:[],tax_percent:10,receipt_lines:[{...files[0],url:'expired',amount:1100,description:'提出済み資材'}]},delivery_invoice_approvals:null}};
 const ctx={exports:{},require:name=>name==='react'?react:name==='react/jsx-runtime'?{jsx,jsxs:jsx}:name==='@bussan/shared'?{staffDisplayName:v=>v,loadInvoiceReceipts:async()=>files,releaseReceiptImages:()=>{},getSupabase:()=>({rpc:async(name,args)=>{calls.push({name,args});return{error:null}}})}:name.endsWith('.css')?{}:{__esModule:true,default:name}};
 vm.runInNewContext(compile(fs.readFileSync('apps/admin/src/components/InvoiceTasks.tsx','utf8')+'\nexport {InvoiceReview};'),ctx);
 async function settle(){for(let i=0;i<20;i++){if(dirty){cursor=0;dirty=false;tree=ctx.exports.InvoiceReview({task,onClose(){},onApproved(){approved++}});pending.splice(0).forEach(fn=>fn())}await Promise.resolve()}}
 await settle();const nodes=all(tree);
 assert.deepEqual(nodes.filter(n=>n.type==='section').map(n=>n.props['aria-label']),['請求書','領収書','領収書の写真PDF']);
 assert(!nodes.some(n=>n.type==='input'||n.type==='details'||String(n.type).endsWith('PackedSummary')));
 assert(!text(tree).includes('承認して外注費に追加'));assert(!text(tree).includes('経費の計上日'));
 const sheet=nodes.find(n=>String(n.type).endsWith('/InvoiceSheet'));assert(sheet);assert.equal(sheet.props.snapshot,task.invoice.snapshot);assert.equal(sheet.props.receipts[0].url,'blob:loaded-photo');assert.equal(sheet.props.receipts[0].amount,1100);
 const preview=nodes.find(n=>typeof n.type==='function'&&n.props.file?.id==='pdf');const pdf=preview.type(preview.props);assert.equal(pdf.type,'object');assert.equal(pdf.props.type,'application/pdf');assert.equal(pdf.props.data,'blob:loaded-pdf');
 const button=nodes.find(n=>n.type==='button'&&text(n)==='承認');assert(button);assert.equal(button.props.disabled,false);assert.equal(calls.length,0);
 nodes.find(n=>n.type==='form').props.onSubmit({preventDefault(){}});await settle();
 assert.equal(approved,1);assert.equal(calls.length,1);assert.equal(calls[0].name,'approve_invoice_documents');assert.deepEqual(JSON.parse(JSON.stringify(calls[0].args)),{p_invoice:'invoice',p_version:7,p_receipt_version:9,p_incurred_on:'2026-10-31'});
 console.log('Invoice review previews and unchanged approval arguments passed.');
})().catch(e=>{console.error(e);process.exitCode=1});
