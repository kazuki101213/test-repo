const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),assert=require('node:assert/strict');
const compile=p=>ts.transpileModule(fs.readFileSync(p,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const jsx=(type,props)=>({type,props});
function all(node,out=[]){if(!node||typeof node!=='object')return out;if(Array.isArray(node)){node.forEach(value=>all(value,out));return out;}out.push(node);all(node.props?.children,out);return out;}
const switchModule={exports:{},require:()=>({}),URLSearchParams};vm.runInNewContext(compile('packages/shared/src/applicationSwitch.ts'),switchModule);
const origin='https://test-repo-delivery.vercel.app/';
async function render(file,resources){
 let cursor=0,hooks=[],pending=[],dirty=true,tree;
 const react={useState(initial){const n=cursor++;hooks[n]??={value:typeof initial==='function'?initial():initial};return[hooks[n].value,value=>{hooks[n].value=typeof value==='function'?value(hooks[n].value):value;dirty=true;}];},useRef(value){return hooks[cursor++]??={current:value};},useEffect(fn,deps){const n=cursor++,old=hooks[n];if(!old||deps.some((value,index)=>value!==old.deps[index])){old?.cleanup?.();const hook=hooks[n]={deps};pending.push(()=>hook.cleanup=fn());}}};
 const shared={readResourceSnapshot:async name=>resources[name]??[],getSupabase:()=>{throw Error('Rendering links must not write to the database');}};
 const context={exports:{},require:name=>name==='react'?react:name==='react/jsx-runtime'?{jsx,jsxs:jsx}:name==='react-dom'?{createPortal:node=>node}:name==='@bussan/shared'?shared:name==='../appUrls'?{deliveryAppUrl:origin}:name==='../taskNotice'?{adminTaskNotice:()=>null}:{},document:{visibilityState:'visible'},window:{setInterval:()=>1,clearInterval(){}}};
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
 inventoryLink(await render('apps/admin/src/components/PhotoReviewTasks.tsx',{listing_tasks:[{id:listingId,sku:'listing',sales_channel:'ヤフオク'}]}),'出品する商品の在庫を開く',listingId);
 const itemId='22222222-2222-4222-8222-222222222222';
 inventoryLink(await render('apps/admin/src/components/MalfunctionTasks.tsx',{actions:[{id:'different-comment-id',item_id:itemId,task_kind:'SONY◯ヤフオク',sku:'auction',created_at:'2026-10-18'}]}),'ヤフオク販売商品の在庫を開く',itemId);
 console.log('PASS: listing and Yahoo task links render with the correct inventory item and open delivery mode without performing transactions');
})().catch(error=>{console.error(error);process.exitCode=1;});
