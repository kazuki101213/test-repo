const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),assert=require('node:assert/strict');
const compile=p=>ts.transpileModule(fs.readFileSync(p,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const jsx=(type,props)=>({type,props});
function all(node,out=[]){if(!node||typeof node!=='object')return out;if(Array.isArray(node)){node.forEach(value=>all(value,out));return out;}out.push(node);all(node.props?.children,out);return out;}
const switchModule={exports:{},require:()=>({}),URLSearchParams};vm.runInNewContext(compile('packages/shared/src/applicationSwitch.ts'),switchModule);
const inventory={exports:{}};vm.runInNewContext(compile('apps/admin/src/inventory.ts'),inventory);
const origin='https://test-repo-delivery.vercel.app/';
const workflow={exports:{}};vm.runInNewContext(compile('packages/shared/src/workflow.ts'),workflow);
async function render(file,resources,products=[]){
 let cursor=0,hooks=[],pending=[],dirty=true,tree;
 const react={useState(initial){const n=cursor++;hooks[n]??={value:typeof initial==='function'?initial():initial};return[hooks[n].value,value=>{hooks[n].value=typeof value==='function'?value(hooks[n].value):value;dirty=true;}];},useRef(value){return hooks[cursor++]??={current:value};},useEffect(fn,deps){const n=cursor++,old=hooks[n];if(!old||deps.some((value,index)=>value!==old.deps[index])){old?.cleanup?.();const hook=hooks[n]={deps};pending.push(()=>hook.cleanup=fn());}}};
 const shared={...workflow.exports,readResourceSnapshot:async name=>resources[name]??[],getSupabase:()=>({from:table=>{assert.equal(table,'items');const q={select:fields=>{assert(['id,marketplace_item_id','id,marketplace,marketplace_item_id,marketplace_url'].includes(fields));return q;},in:(key,ids)=>{assert.equal(key,'id');assert(ids.length<=200);return Promise.resolve({data:products.filter(row=>ids.includes(row.id)),error:null});}};return q;}})};
 const context={exports:{},require:name=>name==='react'?react:name==='react/jsx-runtime'?{jsx,jsxs:jsx}:name==='react-dom'?{createPortal:node=>node}:name==='@bussan/shared'?shared:name==='../inventory'?inventory.exports:name==='../appUrls'?{deliveryAppUrl:origin}:name==='../taskNotice'?{adminTaskNotice:()=>null}:name==='../purchaseUrl'?{purchaseItemUrl:()=>null}:{},document:{visibilityState:'visible'},window:{setInterval:()=>1,clearInterval(){}}};
 vm.runInNewContext(compile(file),context);
 for(let n=0;n<50;n++){if(dirty){cursor=0;dirty=false;tree=context.exports.default({staff:{id:'admin',role:'admin'}});pending.splice(0).forEach(fn=>fn());}await Promise.resolve();}
 hooks.forEach(hook=>hook?.cleanup?.());return all(tree);
}
function inventoryLink(nodes,label,item){
 const link=nodes.find(node=>node.type==='a'&&node.props['aria-label']===label);assert(link,label);
 const url=new URL(link.props.href);assert.equal(url.origin,new URL(origin).origin);assert.equal(url.searchParams.get('itemId'),item);assert.equal(url.searchParams.get('taskKind'),null);
 assert.equal(switchModule.exports.initialApplication(url.search,url.hash,'management'),'delivery','Link opens inventory even when management mode was selected');
 assert.equal(link.props.target,'_blank');assert.equal(link.props.rel,'noopener noreferrer');
}
(async()=>{
 const listingId='11111111-1111-4111-8111-111111111111';
 const listingNodes=await render('apps/admin/src/components/PhotoReviewTasks.tsx',{listing_tasks:[{id:listingId,lot_seq:2395,sku:'2395-EE',sales_channel:'ヤフオク'},{id:'mercari-item',lot_seq:1856,sku:'1856b-EE',sales_channel:'メルカリ'}]},[{id:listingId,marketplace_item_id:'m1245892718'},{id:'mercari-item',marketplace_item_id:'m987654321'}]);
 inventoryLink(listingNodes,'出品する商品の在庫を開く',listingId);
 const text=n=>n==null?'':Array.isArray(n)?n.map(text).join(''):typeof n==='object'?text(n.props?.children):String(n);
 const details=listingNodes.filter(n=>n.props?.className==='task-action-details listing-task-details');
 assert.deepEqual(JSON.parse(JSON.stringify(details.map(n=>n.props.children.filter(v=>typeof v==='object').map(text)))),[['ヤフオク出品','【2395】','【m1245892718】','2395-EE'],['メルカリ出品','【1856b】','【m987654321】','1856b-EE']]);
 const mercariLink=details[1].props.children.find(n=>n?.type==='a');assert.equal(new URL(mercariLink.props.href).searchParams.get('itemId'),'mercari-item');
 const many=Array.from({length:201},(_,n)=>({id:'task'+n,lot_seq:n,sku:'SKU'+n,sales_channel:'ヤフオク'}));
 const manyNodes=await render('apps/admin/src/components/PhotoReviewTasks.tsx',{listing_tasks:many},many.map(t=>({id:t.id,marketplace_item_id:'ID'+t.id})));
 assert.equal(manyNodes.filter(n=>n.props?.className==='task-action-details listing-task-details').length,201,'All task IDs survive bounded query batches');
 const itemId='22222222-2222-4222-8222-222222222222';
 const actionNodes=await render('apps/admin/src/components/MalfunctionTasks.tsx',{malfunctions:['動作不良','Amazon補填申請中'].map((status,n)=>({id:'report'+n,status,sku:(2400+n)+'b-REPORT',lot_seq:2400+n,title:'報告商品',asin:null,marketplace_item_id:'report-product-'+n,people:[],malfunction_reported_at:'2026-10-18T01:00:00Z',malfunction_comment:'報告内容'})),actions:[{id:'different-comment-id',item_id:itemId,task_kind:'SONY◯ヤフオク',sku:'auction',created_at:'2026-10-18'},{id:'supplier-task',item_id:'supplier-item',task_kind:'仕入先確認',lot_seq:2395,marketplace_item_id:'mSUPPLIER',sku:'2395b-SUPPLIER',created_at:'2026-10-18'}]});
 assert(!actionNodes.some(n=>n.props?.id==='admin-action-different-comment-id'),'Obsolete Yahoo sale card is hidden');
 for(let n=0;n<2;n++){
  const report=actionNodes.find(node=>node.props?.id==='admin-malfunction-report'+n);assert(report,'Original malfunction/damage report card remains');
  const fields=all(report).find(node=>node.props?.className==='task-action-details malfunction-report-details');assert(fields);
  assert.deepEqual(JSON.parse(JSON.stringify(fields.props.children.filter(v=>typeof v==='object').map(text))),[[n===0?'動作不良':'破損報告','【'+(2400+n)+'b】','【report-product-'+n+'】',(2400+n)+'b-REPORT']][0]);
  inventoryLink(all(report),'報告商品の在庫を開く','report'+n);
  assert(!all(report).some(node=>node.type==='details'),'Report details removed as requested');
  if(n===0){const conversation=all(report).filter(node=>typeof node.type==='function'&&node.props.item?.id==='report0');assert.equal(conversation.length,1,'One conversation renders actual history, without duplicate fetches');assert.deepEqual(JSON.parse(JSON.stringify(all(conversation[0].props.actions).filter(node=>node.type==='button').map(node=>node.props['data-action']))),['send_back','supplier_check','yahoo_instruction']);}
  assert(all(report).some(node=>node.props?.className==='malfunction-report-message'&&text(node)==='報告内容'),'Original report message remains');
 }
 const supplier=actionNodes.find(n=>n.props?.id==='admin-action-supplier-task');assert(supplier,'Supplier confirmation remains visible');
 const supplierIdentity=all(supplier).find(n=>n.props?.className==='task-action-details supplier-task-details');assert(supplierIdentity);assert.deepEqual(JSON.parse(JSON.stringify(supplierIdentity.props.children.map(text))),['仕入先確認','【2395b】','【mSUPPLIER】','2395b-SUPPLIER']);
 inventoryLink(all(supplier),'仕入先確認商品の在庫を開く','supplier-item');
 const supplierLink=all(supplier).find(n=>n.type==='a'&&n.props['aria-label']==='仕入先確認のメッセージを開く');const supplierUrl=new URL(supplierLink.props.href);assert.equal(supplierUrl.searchParams.get('itemId'),'supplier-item');assert.equal(supplierUrl.searchParams.get('openMessages'),'1');
 console.log('PASS: both listing channels show ordered matching IDs/SKUs, bounded ID reads, inventory links; obsolete Yahoo cards hidden and supplier tasks retained without transactions');
})().catch(error=>{console.error(error);process.exitCode=1;});
