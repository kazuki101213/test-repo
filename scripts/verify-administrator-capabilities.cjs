const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),assert=require('node:assert/strict');
const compile=file=>ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const names={exports:{}};vm.runInNewContext(compile('packages/shared/src/staffNames.ts'),names);
const jsx=(type,props)=>({type,props});
async function verify(staff,search,expectedAutoRead){
 let hooks=[],cursor=0,pending=[],dirty=true,reads=0,includes=[],timers=new Map(),sequence=0;
 const react={useState(initial){const n=cursor++;hooks[n]??={value:typeof initial==='function'?initial():initial};return[hooks[n].value,next=>{hooks[n].value=typeof next==='function'?next(hooks[n].value):next;dirty=true}]},useRef(value){return hooks[cursor++]??={current:value}},useCallback(fn,deps){const n=cursor++;if(!hooks[n]||deps.some((v,i)=>v!==hooks[n].deps[i]))hooks[n]={deps,value:fn};return hooks[n].value},useEffect(fn,deps){const n=cursor++;if(!hooks[n]||deps.some((v,i)=>v!==hooks[n].deps[i])){hooks[n]?.cleanup?.();const h=hooks[n]={deps};pending.push(()=>h.cleanup=fn())}}};
 const item={id:'item',sku:'fixture',title:'fixture',status:'検品中',deliverer_id:'worker'};
 const api={fetchTask:async(_id,include)=>{includes.push(include);return item},fetchComments:async()=>[],fetchSupplierConversation:async()=>{reads++;return{messages:[],outbox:[],expired:true}}};
 const props={itemId:'item',staff,listingSkus:[],mode:'messages',onChanged(){},onOpened(){},onClose(){}};
 const ctx={exports:{},URLSearchParams,crypto:{randomUUID:()=> 'fixture-request'},window:{location:{search},setTimeout(fn){const id=++sequence;timers.set(id,fn);return id},clearTimeout(id){timers.delete(id)}},document:{visibilityState:'visible'},require:id=>id==='react'?react:id==='react/jsx-runtime'?{jsx,jsxs:jsx}:id==='@bussan/shared'?{...names.exports,jpDate:v=>v,canAddPackingPhotos:()=>false}:id==='../api'?api:{default:'placeholder'}};
 vm.runInNewContext(compile('apps/delivery/src/pages/TaskDetail.tsx'),ctx);
 for(let i=0;i<40;i++){if(dirty){dirty=false;cursor=0;ctx.exports.default(props);pending.splice(0).forEach(fn=>fn())}for(const[id,fn]of [...timers]){timers.delete(id);fn()}await Promise.resolve()}
 assert.equal(includes[0],staff.role==='admin','Detail hydration follows the administrator role');
 assert.equal(reads,expectedAutoRead,'Notification links auto-open messages once only for administrators and the matching item');
}
(async()=>{
 for(const code of ['AA','XX','']){
  for(const role of ['admin','purchaser','deliverer'])assert.equal(names.exports.canViewDeliveryAssignee({code,role}),role==='admin');
 }
 const firstAdmin={id:'first',code:'AA',name:'長部一輝',role:'admin',is_active:true};
 const deliverer={id:'delivery',code:'DD',name:'既存の納品担当者',role:'deliverer',is_active:true};
 const secondAdmin={id:'second',code:'XX',name:'追加の管理者',role:'admin',is_active:true,display_name:'XX 追加の管理者'};
 const other={id:'other',code:'YY',name:'名簿にない納品担当者',role:'deliverer',is_active:true};
 const inactive={id:'inactive',code:'ZZ',name:'無効な管理者',role:'admin',is_active:false};
 const options=names.exports.deliveryStaffOptions([secondAdmin,inactive,deliverer,other,firstAdmin]);
 assert.deepEqual(Array.from(options,row=>row.id),['first','delivery','second']);
 assert.equal(names.exports.staffDisplayName(secondAdmin),'XX 追加の管理者');
 await verify({id:'admin',code:'XX',name:'別の管理者',role:'admin'},'?itemId=item&openMessages=1',1);
 await verify({id:'worker',code:'AA',name:'長部一輝',role:'purchaser'},'?itemId=item&openMessages=1',0);
 await verify({id:'worker',code:'AA',name:'長部一輝',role:'deliverer'},'?itemId=item&openMessages=1',0);
 await verify({id:'admin',role:'admin'},'?itemId=item',0);
 await verify({id:'admin',role:'admin'},'?itemId=other&openMessages=1',0);
 console.log('Administrator capabilities ignore staff identity; notification message hydration and auto-open remain role/item scoped');
})().catch(error=>{console.error(error);process.exitCode=1});
