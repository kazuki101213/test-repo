const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),assert=require('node:assert/strict');
const jsx=(type,props)=>({type,props});
function load(file,imports={}){const c={exports:{},require:n=>imports[n]??{}};vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,c);return c.exports;}
const channels=load('packages/shared/src/salesChannels.ts'),palette=load('packages/shared/src/inventoryPresentation.ts'),workflow=load('packages/shared/src/workflow.ts');
const seller=load('packages/shared/src/seller.ts',{'./productCategory':load('packages/shared/src/productCategory.ts')});
const all=(n,out=[])=>{if(Array.isArray(n))n.forEach(x=>all(x,out));else if(n&&typeof n==='object'){out.push(n);all(n.props?.children,out)}return out};
const text=n=>n==null?'':Array.isArray(n)?n.map(text).join(''):typeof n==='object'?text(n.props?.children):String(n);
async function confirm(channel,approved=true,verified=true){
 let hooks=[],cursor=0,pending=[],dirty=true,tree,writes=0,queued=0,changed=0;
 const task={id:'fixture',sku:'9000-AAII-date-100',sales_channel:channel,status:'商品登録前',purchased_at:'2026-10-01',packed_on:null,title:'ホコリセンサーフィルター',condition:'非常に良い',photo_review_approved:approved};
 const context={assignee:'担当者',revision:'revision',operations:[],photo_review_approved:approved};
 const react={useState(v){const n=cursor++;hooks[n]??={value:typeof v==='function'?v():v};return[hooks[n].value,next=>{hooks[n].value=typeof next==='function'?next(hooks[n].value):next;dirty=true}]},useRef(v){return hooks[cursor++]??={current:v}},useEffect(fn,deps){const n=cursor++;if(!hooks[n]||deps.some((d,i)=>d!==hooks[n].deps[i])){hooks[n]={deps};pending.push(fn)}}};
 const api={fetchTask:async()=>task,fetchSellerContext:async()=>context,fetchPhotoUrls:async()=>[],fetchProductMaker:async()=>'',queueSellerOperation:async()=>{queued++},submitAmazonListing:async(id,date)=>{assert.equal(id,task.id);assert.equal(date,'2026-11-06');writes++;return{verified,state:verified?'verified':'accepted',note:'Amazon受付済み：登録結果を確認中'}}};
 const c={exports:{},crypto:{randomUUID:()=>String(Math.random())},window:{setInterval(){return 1},clearInterval(){}},require:n=>n==='react'?react:n==='react/jsx-runtime'?{jsx,jsxs:jsx}:n==='@bussan/shared'?{...seller,...channels,canViewDeliveryAssignee:()=>true}:n==='../api'?api:n==='../listingDraft'?{listingDraft:()=>({...seller.sellerDefaults(task),description:'説明文',listingCategory:''})}:{__esModule:true,default:n.split('/').at(-1)}};
 vm.runInNewContext(ts.transpileModule(fs.readFileSync('apps/delivery/src/components/SellerPanel.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,c);
 async function settle(){for(let i=0;i<50;i++){if(dirty){cursor=0;dirty=false;tree=c.exports.default({mode:'listing',task,staff:{id:'admin',name:'管理者',role:'admin'},onClose(){},onChanged(){changed++}});pending.splice(0).forEach(fn=>fn())}await Promise.resolve()}}
 await settle();const button=all(tree).find(n=>n.type==='button'&&text(n)===(channels.isFbaChannel(channel)?'出品':'出品完了'));assert(button);assert.equal(button.props.disabled,!approved);
 assert(!all(tree).some(n=>n.type==='label'&&text(n).startsWith('出品カテゴリ')),'Amazon must not require a marketplace category');
 button.props.onClick();await settle();const dialog=all(tree).find(n=>n.type==='WorkDateConfirmation');assert(dialog);
 if(approved&&!verified)await assert.rejects(dialog.props.onConfirm('2026-11-06'),/登録結果/);else await dialog.props.onConfirm('2026-11-06');assert.equal(changed,approved&&verified?1:0);assert.equal(task.status,'商品登録前');assert.equal(writes,approved?1:0);assert.equal(queued,0,'Amazon confirmation must not queue a Mercari/Yahoo listing');
}
(async()=>{
 for(const channel of ['FBA','FBA1','FBA2','自己発送','自己発送1','自己発送2']){
  assert.equal(seller.sellerListingCategoryError({category:'小物',listingCategory:''},channel),'');
  assert(workflow.deliveryWorkflowButtons({sku:'9000-test',status:'商品登録前',sales_channel:channel}).some(b=>b.key==='listing_complete'));
  assert.equal(workflow.canAddPackingPhotos({status:'商品登録前',sales_channel:channel}),channels.isFbaChannel(channel));
  assert.equal(workflow.canAddPackingPhotos({status:'出品中',sales_channel:channel}),channels.isSelfShippingChannel(channel));
  await confirm(channel);await confirm(channel,false);await confirm(channel,true,false);
 }
 assert.deepEqual(palette.inventorySiteStyle('FBA1'),palette.inventorySiteStyle('FBA2'));
 assert.deepEqual(palette.inventorySiteStyle('自己発送1'),palette.inventorySiteStyle('自己発送2'));
 assert.notEqual(palette.inventorySiteStyle('FBA1').backgroundColor,palette.inventorySiteStyle('自己発送1').backgroundColor);
 assert.equal(channels.AMAZON_CHANNEL_SELLERS.FBA1,'A1WI3OGPE43N2T');assert.equal(channels.AMAZON_CHANNEL_SELLERS.自己発送1,'A1WI3OGPE43N2T');
 assert.equal(channels.AMAZON_CHANNEL_SELLERS.FBA2,'A3E7BXJWH9TP11');assert.equal(channels.AMAZON_CHANNEL_SELLERS.自己発送2,'A3E7BXJWH9TP11');
 console.log('Amazon 1/2 listing confirmation without category, approval guards, fulfillment stages, seller mapping and shared colors passed');
})().catch(e=>{console.error(e);process.exitCode=1});
