const fs=require('fs'),vm=require('vm'),ts=require('typescript'),assert=require('assert/strict');
const compile=file=>ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const jsx=(type,props)=>({type,props}),all=n=>!n||typeof n!=='object'?[]:Array.isArray(n)?n.flatMap(all):[n,...all(n.props?.children)];
const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
const urlContext={exports:{},URL,encodeURIComponent};vm.runInNewContext(compile('packages/shared/src/noticeUrl.ts'),urlContext);
async function scenario(mode){
 let cursor=0,hooks=[],effects=[],acks=0,reads=0;
 const react={useState(initial){let i=cursor++;hooks[i]??={value:initial};return[hooks[i].value,v=>hooks[i].value=typeof v==='function'?v(hooks[i].value):v];},useRef(value){return hooks[cursor++]??={current:value};},useEffect(fn,deps){let i=cursor++;if(!hooks[i]||deps.some((v,k)=>v!==hooks[i].deps[k])){hooks[i]?.cleanup?.();let h=hooks[i]={deps};effects.push(()=>h.cleanup=fn());}}};
 const row={id:'item',item_id:'item',sku:'2503b-SKU',lot_seq:2503,marketplace:'メルカリ',marketplace_item_id:'m123',marketplace_url:null,submitted_at:'2026-10-19T01:00:00Z',photo_count:1};
 const ctx={exports:{},Date,Set,encodeURIComponent,document:{body:{},visibilityState:'visible',addEventListener(){},removeEventListener(){}},window:{addEventListener(){},removeEventListener(){}},require:id=>id==='react'?react:id==='react-dom'?{createPortal:n=>n}:id==='react/jsx-runtime'?{jsx,jsxs:jsx}:id==='@bussan/shared'?{noticeProductUrl:urlContext.exports.noticeProductUrl,readResourceSnapshot:async name=>{assert.equal(name,'packing_photos');reads++;return[row];},getSupabase:()=>({functions:{invoke:async(name,{body})=>{assert.equal(name,'delivery-photo-drive');assert.equal(body.purpose,'packing');assert.equal(body.action,'list');return{data:{photos:[{id:'photo',url:'signed-photo-url'}]},error:mode==='read-error'?Error('read failed'):null};}},rpc:async(name,args)=>{assert.equal(name,'acknowledge_packing_photos');assert.equal(args.p_item_id,'item');assert.equal(args.p_submitted_at,row.submitted_at);acks++;return{error:null};}})}:id==='../appUrls'?{deliveryAppUrl:'https://delivery/'}:{adminTaskNotice:()=>null}};
 vm.runInNewContext(compile('apps/admin/src/components/PackingPhotoTasks.tsx'),ctx);
 const render=()=>{cursor=0;return ctx.exports.default();},runEffects=async()=>{effects.splice(0).forEach(fn=>fn());await flush();};
 render();await runEffects();let tree=render();assert.equal(reads,1);
 assert(all(tree).some(n=>n.type==='a'&&n.props.href==='https://delivery/?itemId=item'));
 assert(all(tree).some(n=>n.type==='a'&&n.props.href==='https://jp.mercari.com/item/m123'));
 all(tree).find(n=>n.type==='button'&&n.props.children==='確認').props.onClick();tree=render();await runEffects();tree=render();
 const image=all(tree).find(n=>n.type==='img');
 if(mode==='loaded')image.props.onLoad();else if(mode==='image-error')image.props.onError();
 tree=render();await all(tree).find(n=>n.type==='button'&&n.props.children==='閉じる').props.onClick();await flush();tree=render();
 assert.equal(acks,mode==='loaded'?1:0,'Only successfully displayed photos are acknowledged');
 assert.equal(all(tree).some(n=>n.type==='button'&&n.props.children==='確認'),mode!=='loaded','Failed/unseen photos keep the task');
 hooks.forEach(h=>h?.cleanup?.());
}
(async()=>{for(const mode of ['loaded','not-loaded','image-error','read-error'])await scenario(mode);
 const validation={exports:{}};vm.runInNewContext(compile('supabase/functions/delivery-push/validation.ts'),validation);
 const payload=validation.exports.notificationPayload({app_kind:'admin',kind:'packing_photo',item_id:'item',lot_seq:2503});assert.equal(payload.body,'【2503】梱包が追加されました。');assert.equal(payload.kind,'packing_photo');assert.equal(payload.itemId,'item');
 const notice={exports:{},URLSearchParams};vm.runInNewContext(compile('apps/admin/src/taskNotice.ts'),notice);assert.equal(notice.exports.adminTaskNotice('?taskKind=packing_photo&itemId=99681200-0000-0000-0000-000000000001').kind,'packing_photo');
 console.log('PASS: packing gallery read, source/inventory links, loaded-only acknowledgement, failure retention and admin notification routing');
})().catch(e=>{console.error(e);process.exitCode=1;});
