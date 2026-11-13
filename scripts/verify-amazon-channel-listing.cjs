const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),assert=require('node:assert/strict');
const jsx=(type,props)=>({type,props});
function load(file,imports={}){const c={exports:{},require:n=>imports[n]??{}};vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,c);return c.exports;}
const channels=load('packages/shared/src/salesChannels.ts'),palette=load('packages/shared/src/inventoryPresentation.ts'),workflow=load('packages/shared/src/workflow.ts');
const seller=load('packages/shared/src/seller.ts',{'./productCategory':load('packages/shared/src/productCategory.ts')});
const {listingPhotoOrder}=load('apps/delivery/src/listingPhotoOrder.ts');
const photoIds=['remoteBattery','rearRight','frontRight','overview','remoteBack','bottom','rearLeft','frontLeft','remoteFront'];
const photoAnalysis={roles:Object.fromEntries(photoIds.map(id=>[id,id])),accessories:['本体']};
assert.deepEqual(Array.from(listingPhotoOrder(photoIds,photoAnalysis,'amazon',true)),
 ['overview','frontLeft','frontRight','rearLeft','rearRight','remoteBack']);
assert.deepEqual(Array.from(listingPhotoOrder(photoIds,photoAnalysis,'mercari',true)),
 ['overview','frontLeft','frontRight','rearLeft','rearRight','remoteFront','remoteBack','remoteBattery','bottom']);
assert.deepEqual(Array.from(listingPhotoOrder(photoIds,photoAnalysis,'yahoo',true)),
 ['overview','frontLeft','frontRight','rearLeft','rearRight','bottom','remoteFront','remoteBack','remoteBattery']);
assert.deepEqual(Array.from(listingPhotoOrder(['unknown','overview','remoteBattery'],photoAnalysis,'amazon',true)),['overview']);
assert.deepEqual(Array.from(listingPhotoOrder(['unknown','overview','remoteBattery'],photoAnalysis,'amazon',false)),['overview','unknown','remoteBattery']);
const all=(n,out=[])=>{if(Array.isArray(n))n.forEach(x=>all(x,out));else if(n&&typeof n==='object'){out.push(n);all(n.props?.children,out);const actions=n.props?.embedded?.actions;all(typeof actions==='function'?actions(async()=>{},false):actions,out);all(n.props?.embedded?.beforeActions,out);all(n.props?.embedded?.afterActions,out)}return out};
const text=n=>n==null?'':Array.isArray(n)?n.map(text).join(''):typeof n==='object'?text(n.props?.children):String(n);
async function confirm(channel,approved=true,verified=true,scenario='normal'){
 const verifiedNote=channel.startsWith('FBA')?'Amazonへの商品登録を確認しました。FBA納品手続きが完了するまでは商品登録前です。':'Amazonへの登録を確認しました。';
 let hooks=[],cursor=0,effects=[],dirty=true,tree,writes=0,resumes=0,queued=0,changed=0,nextTimer=0;
 const timers=new Map(),document={visibilityState:'visible'};
 const task={id:'fixture',sku:'9000-AAII-date-100',asin:'B015INS3IE',planned_price:scenario==='freshPrice'?null:400,sales_channel:channel,status:'商品登録前',purchased_at:'2026-10-01',packed_on:null,title:'ホコリセンサーフィルター',condition:'非常に良い',photo_review_approved:approved};
 const full={...task,planned_price:scenario==='missingPrice'?null:scenario==='freshPrice'?390:400},context={assignee:'担当者',revision:'revision',operations:[],photo_review_approved:approved};
 const react={useState(v){const n=cursor++;hooks[n]??={value:typeof v==='function'?v():v};return[hooks[n].value,next=>{hooks[n].value=typeof next==='function'?next(hooks[n].value):next;dirty=true}]},useRef(v){return hooks[cursor++]??={current:v}},useEffect(fn,deps){const n=cursor++;if(!hooks[n]||deps.some((d,i)=>d!==hooks[n].deps[i])){hooks[n]?.cleanup?.();const slot=hooks[n]={deps};effects.push(()=>{slot.cleanup=fn()})}}};
 const api={fetchAmazonListingPending:async()=>scenario==='restoredPending'?{requestId:'server-receipt',date:'2026-11-06',photoIds:['photo-2','photo-1']}:null,fetchTask:async()=>full,fetchSellerContext:async()=>context,fetchPhotoUrls:async()=>[{id:'photo-1',url:'https://photos/one.jpg'},{id:'photo-2',url:'https://photos/two.jpg'}],fetchProductMaker:async()=>'',queueSellerOperation:async()=>{queued++},submitAmazonListing:async(id,date,key,photoIds,expected,resume)=>{
  assert.equal(id,task.id);assert.equal(date,'2026-11-06');assert.deepEqual(Array.from(photoIds),['photo-2','photo-1']);assert.equal(expected.price,full.planned_price);assert.equal(expected.sku,task.sku);
  if(resume){resumes++;assert.equal(key,'server-receipt');if(scenario==='resumeRetryable')return{verified:false,state:'retryable',note:'同じSKUで出品を再確認できます。'};if(scenario==='resumeNetwork'&&resumes===1)throw Object.assign(new Error('通信'),{status:502});if(scenario==='resumeConflict')throw Object.assign(new Error('出品内容が変更されています'),{status:409});return{verified:resumes>=2,state:resumes>=2?'verified':'accepted',note:resumes>=2?verifiedNote:'確認中'};}
  writes++;return{verified,state:scenario==='failed'?'failed':verified?'verified':'accepted',note:scenario==='failed'?'Amazonが出品内容を拒否しました':verified?verifiedNote:'Amazon受付済み：登録結果を確認中',requestId:'server-receipt',workCompletedOn:date};
 }};
 const c={exports:{},document,crypto:{randomUUID:()=>String(Math.random())},window:{setInterval(fn){timers.set(++nextTimer,fn);return nextTimer},clearInterval(id){timers.delete(id)}},require:n=>n==='react'?react:n==='react/jsx-runtime'?{jsx,jsxs:jsx}:n==='@bussan/shared'?{...seller,...channels,canViewDeliveryAssignee:()=>true}:n==='../api'?api:n==='../listingDraft'?{listingDraft:()=>({...seller.sellerDefaults(full),description:'説明文',listingCategory:''})}:{__esModule:true,default:n.split('/').at(-1)}};
 vm.runInNewContext(ts.transpileModule(fs.readFileSync('apps/delivery/src/components/SellerPanel.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,c);
 async function settle(){for(let i=0;i<80;i++){if(dirty){cursor=0;dirty=false;tree=c.exports.default({mode:'listing',task,staff:{id:'admin',name:'管理者',role:'admin'},onClose(){},onChanged(){changed++}});effects.splice(0).forEach(fn=>fn())}await Promise.resolve()}}
 const button=()=>all(tree).find(n=>n.type==='button'&&text(n)==='出品'),dialog=()=>all(tree).find(n=>n.type==='WorkDateConfirmation');
 await settle();assert(button());
 if(scenario==='restoredPending'){assert(button().props.disabled);assert.equal(writes,0);assert.equal(timers.size,1);const tick=[...timers.values()][0];tick();await settle();tick();await settle();assert.equal(resumes,2);assert.equal(writes,0,'restored receipt must never create another listing');assert.equal(changed,1);assert.equal(timers.size,0);assert(all(tree).some(n=>n.props?.role==='status'&&text(n)===verifiedNote));return;}
 assert.equal(button().props.disabled,!approved);assert(!all(tree).some(n=>n.type==='label'&&text(n).startsWith('出品カテゴリ')));
 if(!approved){assert.equal(writes,0);return;}
 assert(all(tree).some(n=>n.props?.['aria-label']==='出品写真の掲載順'));
 all(tree).find(n=>n.props?.['aria-label']==='写真1を後へ').props.onClick();await settle();button().props.onClick();await settle();
 if(scenario==='missingPrice'){assert(!dialog());assert(all(tree).some(n=>n.props?.role==='alert'&&text(n).includes('予定販売価格')));assert.equal(writes,0);return;}
 assert(dialog());assert(dialog().props.title.includes(String(full.planned_price)+'円'));assert(!dialog().props.title.includes('未登録'));
 if(scenario==='failed'){await assert.rejects(dialog().props.onConfirm('2026-11-06'),/拒否/);await settle();assert.equal(timers.size,0);assert.equal(changed,0);return;}
 await dialog().props.onConfirm('2026-11-06');dialog().props.onCancel();await settle();assert(!dialog());assert.equal(changed,verified?1:0);assert.equal(writes,1);assert.equal(queued,0);if(verified)assert(all(tree).some(n=>n.props?.role==='status'&&text(n)===verifiedNote));
 if(!verified){
  assert(all(tree).some(n=>n.props?.role==='status'&&text(n).includes('自動確認')));assert(!all(tree).some(n=>n.props?.role==='alert'));assert(button().props.disabled);assert.equal(timers.size,1);
  const tick=[...timers.values()][0];document.visibilityState='hidden';tick();await settle();assert.equal(resumes,0);document.visibilityState='visible';tick();await settle();
  if(scenario==='resumeRetryable'){assert.equal(timers.size,0);assert(!button().props.disabled);assert.equal(writes,1);assert(all(tree).some(n=>n.props?.role==='status'&&text(n).includes('同じSKU')));return;}
  if(scenario==='resumeConflict'){assert.equal(timers.size,0);assert.equal(changed,0);assert(all(tree).some(n=>n.props?.role==='alert'&&text(n).includes('変更')));return;}
  assert.equal(changed,0);assert.equal(writes,1);if(scenario==='resumeNetwork')assert(all(tree).some(n=>n.props?.role==='status'&&text(n).includes('通信')));
  tick();await settle();assert.equal(resumes,2);assert.equal(changed,1);assert.equal(writes,1,'polling must not submit a listing again');assert.equal(timers.size,0,'timer cleanup after verified result');assert(all(tree).some(n=>n.props?.role==='status'&&text(n)===verifiedNote));assert(!all(tree).some(n=>n.props?.role==='alert'));
 }
}
(async()=>{
 for(const channel of ['FBA','FBA1','FBA2','自己発送','自己発送1','自己発送2']){
  assert.equal(seller.sellerListingCategoryError({category:'小物',listingCategory:''},channel),'');
  assert(workflow.deliveryWorkflowButtons({sku:'9000-test',status:'商品登録前',sales_channel:channel}).some(b=>b.key==='listing_complete'));
  assert.equal(workflow.canAddPackingPhotos({status:'商品登録前',sales_channel:channel}),channels.isFbaChannel(channel));
  assert.equal(workflow.canAddPackingPhotos({status:'出品中',sales_channel:channel}),channels.isSelfShippingChannel(channel));
  await confirm(channel);await confirm(channel,false);await confirm(channel,true,false);await confirm(channel,true,true,'missingPrice');await confirm(channel,true,true,'freshPrice');
 }
 await confirm('FBA2',true,false,'restoredPending');await confirm('FBA2',true,false,'resumeRetryable');await confirm('FBA2',true,false,'resumeNetwork');await confirm('自己発送2',true,false,'resumeConflict');await confirm('FBA2',true,false,'failed');
 assert.deepEqual(palette.inventorySiteStyle('FBA1'),palette.inventorySiteStyle('FBA2'));
 assert.deepEqual(palette.inventorySiteStyle('自己発送1'),palette.inventorySiteStyle('自己発送2'));
 assert.notEqual(palette.inventorySiteStyle('FBA1').backgroundColor,palette.inventorySiteStyle('自己発送1').backgroundColor);
 assert.equal(channels.AMAZON_CHANNEL_SELLERS.FBA1,'A1WI3OGPE43N2T');assert.equal(channels.AMAZON_CHANNEL_SELLERS.自己発送1,'A1WI3OGPE43N2T');
 assert.equal(channels.AMAZON_CHANNEL_SELLERS.FBA2,'A3E7BXJWH9TP11');assert.equal(channels.AMAZON_CHANNEL_SELLERS.自己発送2,'A3E7BXJWH9TP11');
 console.log('Amazon 1/2 listing confirmation without category, approval guards, fulfillment stages, seller mapping and shared colors passed');
})().catch(e=>{console.error(e);process.exitCode=1});
