const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),assert=require('node:assert/strict'),path=require('node:path');
const root=path.resolve(__dirname,'..');
const compile=f=>ts.transpileModule(fs.readFileSync(path.join(root,f),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const workflow={exports:{}};vm.runInNewContext(compile('packages/shared/src/workflow.ts'),workflow);
const constants={exports:{}};vm.runInNewContext(compile('packages/shared/src/constants.ts'),constants);
let rpcCalls=[],rpcError=null;const actualApi={exports:{},require:id=>id==='@bussan/shared'?{getSupabase:()=>({rpc:async(name,args)=>{rpcCalls.push([name,args]);return{error:rpcError};}})}:{}};
vm.runInNewContext(compile('apps/delivery/src/api.ts'),actualApi);
let uploadPurpose=null,readPurpose=null,driveCalls=0,driveFail=false,reflectCalls=0,reflectRelease;
let row={id:'one',sku:'2400-AAII-20261008-1000',marketplace:'ヤフオク',status:'商品登録前',product_registered:false,photo_uploaded:false,inspected:false,cleaned:false,packed_on:null,shipped_on:null,malfunction_reported:false},photos=[],progress=[],photoEvents=0,uploadFailAt=0,uploads=0;
const api={reflectOriginalProductPhotos:async()=>{reflectCalls++;await new Promise(resolve=>reflectRelease=resolve);photos.push({id:'reflected',url:'reflected',canDelete:true});return{sourceSerial:'2400',added:1,total:photos.length};},fetchTask:async()=>({...row}),fetchComments:async()=>[],fetchPhotoUrls:async(id,purpose)=>{readPurpose=purpose;return [...photos];},fetchPhotoReview:async()=>null,fetchPhotoReviewPolicy:async()=>false,uploadPhoto:async(sku,id,staff,file,purpose)=>{uploadPurpose=purpose;uploads++;if(uploads===uploadFailAt)throw new Error('写真ファイルエラー');photos.push({id:String(uploads),url:'photo',canDelete:true});},recordListingPhotoUpload:async id=>{photoEvents++;await actualApi.exports.recordListingPhotoUpload(id);row.photo_uploaded=true;},setDeliveryProgress:async(id,step,done)=>{progress.push([step,done]);if(step==='listing'){row.product_registered=done;row.photo_uploaded=done;}},addPhotosToDrive:async()=>{driveCalls++;if(driveFail)throw Error('Drive error');return {added:photos.length,total:photos.length};}};
let cursor=0,hooks=[],pending=[],dirty=true,tree;
const react={useState(v){const n=cursor++;if(!hooks[n])hooks[n]={value:v};return[hooks[n].value,next=>{hooks[n].value=typeof next==='function'?next(hooks[n].value):next;dirty=true;}];},useRef(v){return hooks[cursor++]??={current:v};},useCallback(fn,deps){const n=cursor++;if(!hooks[n]||deps.some((v,i)=>v!==hooks[n].deps[i]))hooks[n]={deps,value:fn};return hooks[n].value;},useEffect(fn,deps){const n=cursor++;if(!hooks[n]||deps.some((v,i)=>v!==hooks[n].deps[i])){hooks[n]?.cleanup?.();const h=hooks[n]={deps};pending.push(()=>h.cleanup=fn());}}};
const jsx=(type,props)=>({type,props});
const context={exports:{},crypto:require('node:crypto').webcrypto,Date,Intl,URLSearchParams,require:id=>id==='react'?react:id==='react/jsx-runtime'?{jsx,jsxs:jsx}:id==='@bussan/shared'?{...constants.exports,...workflow.exports,jpDate:x=>x??'—',canViewDeliveryAssignee:()=>false,staffDisplayName:x=>x??''}:id==='../api'?api:{default:'component'},window:{location:{search:''},setTimeout(){}}};
vm.runInNewContext(compile('apps/delivery/src/pages/TaskDetail.tsx'),context);
const props={itemId:'one',staff:{id:'II',code:'II',role:'deliverer',name:'久保田真由'},listingSkus:[],onChanged(){},onOpened(){},onClose(){}};
function all(n,out=[]){if(!n||typeof n!=='object')return out;if(Array.isArray(n)){n.forEach(v=>all(v,out));return out;}out.push(n);all(n.props?.children,out);return out;}
function text(n){return n==null?'':Array.isArray(n)?n.map(text).join(''):typeof n==='object'?text(n.props?.children):String(n);}
async function settle(){for(let i=0;i<40;i++){if(dirty){cursor=0;dirty=false;tree=context.exports.default(props);pending.splice(0).forEach(fn=>fn());}await Promise.resolve();}}
const listing=()=>all(tree).find(n=>n.type==='button'&&text(n).includes('商品登録・写真登録'));
function upload(files){all(tree).find(n=>n.props?.['aria-label']==='商品写真表示').props.onChange({target:{files,value:'file'}});}
(async()=>{
 await settle();assert(!listing(),'Legacy combined progress control is removed');
 upload([{name:'a'},{name:'b'}]);upload([{name:'duplicate'}]);await settle();assert.equal(photos.length,2);assert.equal(driveCalls,1,'Complete product batch automatically reaches Drive and review submission');assert(text(tree).includes('写真確認に提出しました'));assert.equal(photoEvents,1);assert.equal(row.product_registered,false);assert(!listing());assert.equal(rpcCalls[0][0],'set_delivery_listing_progress');assert.equal(rpcCalls[0][1].p_done,null);assert.equal(rpcCalls[0][1].p_item_id,'one');
 uploadFailAt=uploads+2;upload([{name:'c'},{name:'bad'}]);await settle();assert.equal(photos.length,3);assert.equal(driveCalls,1,'Partial upload cannot submit an incomplete photo batch');assert.equal(photoEvents,1,'Partial success preserves the existing photo progress without redundant writes');assert.equal(row.product_registered,false);assert(!listing());assert(text(tree).includes('写真ファイルエラー'));assert(text(tree).includes('写真 3枚'));
 assert(all(tree).some(n=>n.props?.['aria-label']==='商品写真をすべて端末に保存'));assert(all(tree).some(n=>n.type==='button'&&text(n).includes('Googleドライブ追加')));
 driveFail=true;uploadFailAt=0;upload([{name:'drive-failed'}]);await settle();assert.equal(driveCalls,2);assert(text(tree).includes('写真はアプリに保存済み'));assert.equal(photos.length,4);
 driveFail=false;const uploadedBeforeRetry=uploads;all(tree).find(n=>n.type==='button'&&text(n)==='Googleドライブ追加').props.onClick();await settle();assert.equal(uploads,uploadedBeforeRetry,'Retry submits saved photos without uploading duplicates');assert.equal(driveCalls,3);assert(!text(tree).includes('Drive error'));
 hooks=[];pending=[];dirty=true;row={...row,marketplace:'動作品Amazon返品',product_registered:true,photo_uploaded:false};await settle();assert(!listing());assert(!all(tree).some(n=>n.type==='button'&&text(n).includes('商品登録')));
 hooks=[];pending=[];dirty=true;row={...row,sku:'2400a-AAII-20261008-1000'};await settle();
 const reflect=()=>all(tree).find(n=>n.type==='button'&&text(n)==='写真反映');
 assert(reflect());assert.equal(reflect().props.className,'btn photo-reflect');
 const beforeReflection=driveCalls;reflect().props.onClick();reflect().props.onClick();await settle();assert.equal(reflectCalls,1);assert(all(tree).find(n=>n.props?.['aria-label']==='商品写真をすべて端末に保存').props.disabled);
 reflectRelease();await settle();assert.equal(driveCalls,beforeReflection,'Reflection cannot automatically submit review');assert(text(tree).includes('Googleドライブ追加」で保存してください'));
 all(tree).find(n=>n.type==='button'&&text(n)==='Googleドライブ追加').props.onClick();await settle();assert.equal(driveCalls,beforeReflection+1);
 hooks=[];pending=[];dirty=true;props.mode='packingPhotos';row={...row,marketplace:'ヤフオク',status:'出品中',sales_channel:'メルカリ',photo_uploaded:false};await settle();
 assert.equal(readPurpose,'packing');assert(!all(tree).some(n=>n.props?.className==='btn photo-reflect'));const priorEvents=photoEvents;uploadFailAt=0;all(tree).find(n=>n.props?.['aria-label']==='梱包写真追加').props.onChange({target:{files:[{name:'packed'}],value:'file'}});await settle();assert.equal(driveCalls,5,'A complete packing batch is also saved and notifies management');assert.equal(uploadPurpose,'packing');assert.equal(photoEvents,priorEvents,'Packing evidence must not mark product photos complete');assert.equal(row.status,'出品中');
 rpcError={message:'写真の記録に失敗しました'};await assert.rejects(actualApi.exports.recordListingPhotoUpload('one'),{message:rpcError.message});
 assert.deepEqual(Array.from(constants.exports.STATUSES),["受取前","検品中","Amazon返送依頼","Amazon補填申請中","商品登録前","出品中","取引中","販売済","返品処理","動作不良"]);assert(!('出荷済' in constants.exports.STATUS_COLORS));
 console.log('Photo-only upload and partial failure preserve product registration; photos-only detail has no obsolete progress or zero-sale controls');
})().catch(e=>{console.error(e);process.exitCode=1;});
