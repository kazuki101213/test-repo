const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),assert=require('node:assert/strict'),path=require('node:path');
const root=path.resolve(__dirname,'..');
const compile=f=>ts.transpileModule(fs.readFileSync(path.join(root,f),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const constants={exports:{}};vm.runInNewContext(compile('packages/shared/src/constants.ts'),constants);
let rpcCalls=[],rpcError=null;const actualApi={exports:{},require:id=>id==='@bussan/shared'?{getSupabase:()=>({rpc:async(name,args)=>{rpcCalls.push([name,args]);return{error:rpcError};}})}:{}};
vm.runInNewContext(compile('apps/delivery/src/api.ts'),actualApi);
let row={id:'one',sku:'2400-AAII-20261008-1000',marketplace:'ヤフオク',status:'作業中',product_registered:false,photo_uploaded:false,inspected:false,cleaned:false,packed_on:null,shipped_on:null,malfunction_reported:false},photos=[],progress=[],photoEvents=0,uploadFailAt=0,uploads=0;
const api={fetchTask:async()=>({...row}),fetchComments:async()=>[],fetchPhotoUrls:async()=>[...photos],fetchPhotoReview:async()=>null,fetchPhotoReviewPolicy:async()=>false,uploadPhoto:async(sku,id,staff,file)=>{uploads++;if(uploads===uploadFailAt)throw new Error('写真ファイルエラー');photos.push({id:String(uploads),url:'photo',canDelete:true});},recordListingPhotoUpload:async id=>{photoEvents++;await actualApi.exports.recordListingPhotoUpload(id);row.photo_uploaded=true;},setDeliveryProgress:async(id,step,done)=>{progress.push([step,done]);if(step==='listing'){row.product_registered=done;row.photo_uploaded=done;}},addPhotosToDrive:async()=>photos.length};
let cursor=0,hooks=[],pending=[],dirty=true,tree;
const react={useState(v){const n=cursor++;if(!hooks[n])hooks[n]={value:v};return[hooks[n].value,next=>{hooks[n].value=typeof next==='function'?next(hooks[n].value):next;dirty=true;}];},useRef(v){return hooks[cursor++]??={current:v};},useCallback(fn,deps){const n=cursor++;if(!hooks[n]||deps.some((v,i)=>v!==hooks[n].deps[i]))hooks[n]={deps,value:fn};return hooks[n].value;},useEffect(fn,deps){const n=cursor++;if(!hooks[n]||deps.some((v,i)=>v!==hooks[n].deps[i])){hooks[n]?.cleanup?.();const h=hooks[n]={deps};pending.push(()=>h.cleanup=fn());}}};
const jsx=(type,props)=>({type,props});
const context={exports:{},Date,Intl,URLSearchParams,require:id=>id==='react'?react:id==='react/jsx-runtime'?{jsx,jsxs:jsx}:id==='@bussan/shared'?{...constants.exports,jpDate:x=>x??'—',canViewDeliveryAssignee:()=>false,staffDisplayName:x=>x??''}:id==='../api'?api:{default:'component'},window:{location:{search:''},setTimeout(){}}};
vm.runInNewContext(compile('apps/delivery/src/pages/TaskDetail.tsx'),context);
const props={itemId:'one',staff:{id:'II',code:'II',role:'deliverer',name:'久保田真由'},listingSkus:[],onChanged(){},onOpened(){},onClose(){}};
function all(n,out=[]){if(!n||typeof n!=='object')return out;if(Array.isArray(n)){n.forEach(v=>all(v,out));return out;}out.push(n);all(n.props?.children,out);return out;}
function text(n){return n==null?'':Array.isArray(n)?n.map(text).join(''):typeof n==='object'?text(n.props?.children):String(n);}
async function settle(){for(let i=0;i<40;i++){if(dirty){cursor=0;dirty=false;tree=context.exports.default(props);pending.splice(0).forEach(fn=>fn());}await Promise.resolve();}}
const listing=()=>all(tree).find(n=>n.type==='button'&&text(n).includes('商品登録・写真登録'));
function upload(files){all(tree).find(n=>n.props?.['aria-label']==='商品写真追加').props.onChange({target:{files,value:'file'}});}
(async()=>{
 await settle();assert.equal(listing().props['aria-pressed'],false);
 upload([{name:'a'},{name:'b'}]);await settle();assert.equal(photos.length,2);assert.equal(photoEvents,1);assert.equal(row.product_registered,false);assert.equal(listing().props['aria-pressed'],false);assert.equal(rpcCalls[0][0],'set_delivery_listing_progress');assert.equal(rpcCalls[0][1].p_done,null);assert.equal(rpcCalls[0][1].p_item_id,'one');
 listing().props.onClick();await settle();assert.equal(listing().props['aria-pressed'],true);assert.deepEqual(progress.at(-1),['listing',true]);
 listing().props.onClick();await settle();assert.equal(listing().props['aria-pressed'],false);
 uploadFailAt=uploads+2;upload([{name:'c'},{name:'bad'}]);await settle();assert.equal(photos.length,3);assert.equal(photoEvents,2,'Partial successful upload records photo progress');assert.equal(row.product_registered,false);assert.equal(listing().props['aria-pressed'],false);assert(text(tree).includes('写真ファイルエラー'));assert(text(tree).includes('写真 3枚'));
 assert(all(tree).some(n=>n.props?.['aria-label']==='商品写真をすべて端末に保存'));assert(all(tree).some(n=>n.type==='button'&&text(n).includes('Googleドライブ追加')));
 hooks=[];pending=[];dirty=true;row={...row,marketplace:'動作品Amazon返品',product_registered:true,photo_uploaded:false};await settle();assert(!listing());const exemption=all(tree).find(n=>n.type==='button'&&text(n).includes('商品登録'));assert.equal(exemption.props['aria-pressed'],true);
 rpcError={message:'写真の記録に失敗しました'};await assert.rejects(actualApi.exports.recordListingPhotoUpload('one'),{message:rpcError.message});
 assert.deepEqual(Array.from(constants.exports.STATUSES),['作業中','出品中','販売済','返品処理']);assert(!('出荷済' in constants.exports.STATUS_COLORS));
 console.log('Photo-only upload, combined check/uncheck, partial failure, display/save controls, working return exemption and four states passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
