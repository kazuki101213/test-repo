const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),assert=require('node:assert/strict');
const jsx=(type,props)=>({type,props});
const nodes=(node,out=[])=>{if(Array.isArray(node))node.forEach(value=>nodes(value,out));else if(node&&typeof node==='object'){out.push(node);nodes(node.props?.children,out);}return out};
const text=node=>node==null?'':Array.isArray(node)?node.map(text).join(''):typeof node==='object'?text(node.props?.children):String(node);
function mount(path,sb,props={}) {
 let hooks=[],cursor=0,dirty=true,tree;
 const react={useState(value){const i=cursor++;hooks[i]??={value};return[hooks[i].value,next=>{hooks[i].value=typeof next==='function'?next(hooks[i].value):next;dirty=true}]},useRef(value){return hooks[cursor++]??={current:value}}};
 const context={exports:{},require:name=>name==='react'?react:name==='react/jsx-runtime'?{jsx,jsxs:jsx}:name==='@bussan/shared'?{getSupabase:()=>sb}:{},Response,setTimeout:fn=>{fn();return 1},Date};
 const code=ts.transpileModule(fs.readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText;
 vm.runInNewContext(code,context);
 return {get tree(){return tree},async settle(){for(let i=0;i<90;i++){if(dirty){cursor=0;dirty=false;tree=context.exports.default(props)}await Promise.resolve()}}};
}
(async()=>{
 const calls=[];
 const inventory=mount('apps/admin/src/pages/AmazonInventory.tsx',{functions:{async invoke(name,{body}){
  calls.push({...body});assert.equal(name,'amazon-fba-inventory');
  return {data:{accountId:body.accountId,rows:[{sku:'same',name:body.accountId,total:1}],nextToken:body.nextToken?undefined:body.accountId+'-next',fetchedAt:'2026-11-05T00:00:00Z'}};
 }}});
 await inventory.settle();
 const button=(view,label)=>nodes(view.tree).find(node=>node.type==='button'&&text(node)===label);
 button(inventory,'最新の在庫を取得').props.onClick();await inventory.settle();
 assert(text(inventory.tree).includes('amazon-1'));assert(button(inventory,'次のページ'));
 nodes(inventory.tree).find(node=>node.type==='select').props.onChange({target:{value:'amazon-2'}});await inventory.settle();
 assert(!text(inventory.tree).includes('amazon-1'),'Previous account rows remained visible');assert(!button(inventory,'次のページ'),'Previous account token remained');
 button(inventory,'最新の在庫を取得').props.onClick();await inventory.settle();
 button(inventory,'次のページ').props.onClick();await inventory.settle();
 assert.equal(calls[1].accountId,'amazon-2');assert.equal(calls[1].nextToken,undefined);assert.equal(calls[2].nextToken,'amazon-2-next');

 const actions=[];let applied=0;
 const sync=mount('apps/admin/src/components/AmazonSalesSync.tsx',{
  from(){return{select(){return this},not(){return this},order(){return this},limit(){return this},async maybeSingle(){return{data:{purchased_at:new Date(Date.now()-86400000).toISOString().slice(0,10)}}}}},
  functions:{async invoke(name,{body}){
   assert.equal(name,'amazon-payments');actions.push({...body});
   if(body.action==='accounts')return{data:{accounts:[{id:'amazon-1',label:'Amazon1',hasConfiguration:true},{id:'amazon-2',label:'Amazon2',hasConfiguration:true}]}};
   if(body.accountId==='amazon-1')return{error:{context:new Response(JSON.stringify({error:'認可を確認してください。'}))}};
   if(body.action==='sync')return{data:{saved:1,nextToken:body.nextToken?undefined:'second-next'}};
   if(body.action==='history')return{data:{hasMore:body.offset===0,rows:body.offset===0?[{transaction_id:'only-second'}]:[]}};
   if(body.action==='reconcile')return{data:{results:[{status:'applied'}]}};
   throw new Error('Unexpected action');
  }}
 },{onApplied(){applied++}});
 await sync.settle();button(sync,'Amazon情報更新').props.onClick();button(sync,'Amazon情報更新').props.onClick();await sync.settle();
 assert.equal(actions.filter(row=>row.action==='accounts').length,1,'Double click restarted synchronization');
 assert(actions.some(row=>row.action==='sync'&&row.accountId==='amazon-2'&&row.nextToken==='second-next'),'Second account pagination missing');
 assert(actions.some(row=>row.action==='history'&&row.accountId==='amazon-2'&&row.offset===100),'Second account history paging missing');
 assert(actions.some(row=>row.action==='reconcile'&&row.accountId==='amazon-2'&&row.transactionId==='only-second'));
 assert(text(sync.tree).includes('Amazon1: 認可を確認してください。'),'Failed account was hidden');assert(applied>=1);
 console.log('Amazon account switch clears rows/tokens; sync, history and reconciliation preserve account; one failure does not block the other.');
})().catch(error=>{console.error(error);process.exitCode=1});
