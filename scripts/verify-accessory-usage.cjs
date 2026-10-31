const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const compile=f=>ts.transpileModule(fs.readFileSync(path.join(root,f),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const jsx=(type,props)=>({type,props});
function all(n,out=[]){if(!n||typeof n!=='object')return out;if(Array.isArray(n)){n.forEach(v=>all(v,out));return out;}out.push(n);all(n.props?.children,out);return out;}
(async()=>{
 const writes=[];const api={exports:{},require:()=>({getSupabase:()=>({rpc:async(name,args)=>{writes.push({name,args});return{data:{item_id:'remote',serial:args.p_serial,sku:'2448-AAHH-date-161'},error:null};}})})};
 vm.runInNewContext(compile('packages/shared/src/accessoryUsage.ts'),api);
 await assert.rejects(api.exports.reassignAccessoryUsage('remote','bad','rev'));assert.equal(writes.length,0);
 await api.exports.reassignAccessoryUsage('remote',' 2448B ','rev');
 assert.deepEqual(JSON.parse(JSON.stringify(writes[0])),{name:'reassign_accessory_usage',args:{p_item_id:'remote',p_serial:'2448b',p_expected_revision:'rev'}});
 {
  let cursor=0,hooks=[],effects=[],tree,dirty=true,reads=0,saves=[],closed=0,saved=[],finish;
  const react={useState(v){const n=cursor++;if(!hooks[n])hooks[n]={value:v};return[hooks[n].value,x=>{hooks[n].value=x;dirty=true;}];},useRef(v){const n=cursor++;return hooks[n]??(hooks[n]={current:v});},useEffect(fn,deps){const n=cursor++;if(!hooks[n]||deps.some((v,i)=>v!==hooks[n].deps[i])){hooks[n]={deps};effects.push(fn);}}};
  const ctx={exports:{},require:id=>id==='react'?react:id==='react/jsx-runtime'?{jsx,jsxs:jsx}:id==='@bussan/shared'?{
   fetchAccessoryUsage:async()=>{reads++;return{serial:'2447',sku:'2447-AAHH-date-161',revision:'exact-revision'};},
   reassignAccessoryUsage:(...args)=>{saves.push(args);return new Promise(resolve=>{finish=()=>resolve({serial:'2448'});});}
  }:{}};
  vm.runInNewContext(compile('apps/admin/src/components/AccessoryUsageDialog.tsx'),ctx);
  const props={itemId:'remote',onClose:()=>closed++,onSaved:async serial=>saved.push(serial)};
  const flush=async()=>{for(let i=0;i<10;i++){if(dirty){cursor=0;dirty=false;tree=ctx.exports.default(props);effects.splice(0).forEach(fn=>fn());}await Promise.resolve();}};
  await flush();assert.equal(reads,1);assert.equal(saves.length,0,'Opening must not move data');
  assert.equal(all(tree).find(x=>x.type==='input').props.value,'2447');
  all(tree).find(x=>x.type==='input').props.onChange({target:{value:'2448'}});await flush();
  const form=all(tree).find(x=>x.type==='form');form.props.onSubmit({preventDefault(){}});form.props.onSubmit({preventDefault(){}});
  assert.equal(saves.length,1,'Double submit must not transfer twice');assert.deepEqual(saves[0],['remote','2448','exact-revision']);
  finish();await flush();assert.deepEqual(saved,['2448']);
  all(tree).find(x=>x.type==='button'&&x.props.type==='button').props.onClick();assert.equal(closed,1);assert.equal(saves.length,1);
 }
 console.log('Management photo-detail usage editor loads without writes, preserves revision, normalizes serial and prevents duplicate transfers');
})().catch(error=>{console.error(error);process.exitCode=1;});
