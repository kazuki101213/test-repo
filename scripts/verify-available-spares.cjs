const fs=require('fs'),vm=require('vm'),ts=require('typescript'),assert=require('assert/strict');
const compile=f=>ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const names={exports:{}};vm.runInNewContext(compile('packages/shared/src/staffNames.ts'),names);
let database=Array.from({length:1003},(_,i)=>({id:String(i),title:'spare-'+i,owner_staff_id:'EE',owner_name:'石川秀櫢',manufacturer:'Panasonic',used_for_item_id:i===800?'body':null}));
const queries=[];
const sb={from(table){const filters=[];let start=0,end=499;const query={select(){return query;},order(){return query;},range(a,b){start=a;end=b;return query;},is(k,v){filters.push([k,v]);return query;},eq(k,v){filters.push([k,v]);return query;},in(){return query;},then(resolve){queries.push({table,filters,start});const rows=table==='staff'?[{id:'EE',code:'EE',name:'石川秀櫢'}]:database.filter(row=>filters.every(([k,v])=>row[k]===v)).slice(start,end+1);return Promise.resolve({data:rows,error:null}).then(resolve);}};return query;}};
const moduleContext={exports:{},require:id=>id==='./staffNames'?names.exports:{getSupabase:()=>sb},Intl};
vm.runInNewContext(compile('packages/shared/src/spares.ts'),moduleContext);
const jsx=(type,props)=>({type,props});
const allText=n=>n==null?'':Array.isArray(n)?n.map(allText).join(''):typeof n==='object'?allText(n.props?.children):String(n);
(async()=>{
 const available=await moduleContext.exports.fetchSpareAccessories();assert.equal(available.length,1002);assert(!available.some(r=>r.id==='800'));assert(available.some(r=>r.id==='1002'));
 assert(queries.filter(q=>q.table==='spare_accessories').every(q=>q.filters.some(([k,v])=>k==='used_for_item_id'&&v===null)));
 assert.equal((await moduleContext.exports.fetchSpareAccessories('II')).length,0);
 for(const app of ['admin','delivery']){
  let cursor=0,hooks=[],effects=[],dirty=true,tree,visible='visible',timer,events={},calls=0;
  const depsEqual=(a,b)=>a&&b&&a.length===b.length&&a.every((x,i)=>x===b[i]);
  const react={useState(v){const i=cursor++;if(!hooks[i])hooks[i]={value:typeof v==='function'?v():v};return[hooks[i].value,x=>{hooks[i].value=typeof x==='function'?x(hooks[i].value):x;dirty=true;}];},useRef(v){return hooks[cursor++]??={current:v};},useCallback(fn,deps){const i=cursor++;if(!hooks[i]||!depsEqual(hooks[i].deps,deps))hooks[i]={deps,fn};return hooks[i].fn;},useEffect(fn,deps){const i=cursor++;if(!hooks[i]||!depsEqual(hooks[i].deps,deps)){hooks[i]?.cleanup?.();hooks[i]={deps};effects.push(()=>{hooks[i].cleanup=fn();});}}};
  let rows=[{id:'available',title:'AVAILABLE-ROW',owner_staff_id:'EE',used_for_item_id:null,cost_amount:1500}];
  const shared={...names.exports,MARKETPLACES:[],yen:v=>String(v),spareState:()=>'',fetchSpareAccessories:async()=>{calls++;return rows;}};
  const context={exports:{},require:id=>id==='react'?react:id==='react/jsx-runtime'?{jsx,jsxs:jsx}:id==='@bussan/shared'?shared:id==='../api'?{fetchStaff:async()=>[],fetchSpareOwners:async()=>[]}:{default:'placeholder'},window:{setInterval:fn=>{timer=fn;return 1;},clearInterval(){},addEventListener:(key,fn)=>events[key]=fn,removeEventListener:key=>delete events[key]},document:{get visibilityState(){return visible;},addEventListener:(key,fn)=>events[key]=fn,removeEventListener:key=>delete events[key]}};
  vm.runInNewContext(compile('apps/'+app+'/src/pages/Spares.tsx'),context);
  const person={id:'AA',code:'AA',role:'admin',name:'長部一輝'};
  async function settle(){for(let i=0;i<12;i++){if(dirty){cursor=0;dirty=false;tree=context.exports.default({me:person,staff:person});effects.splice(0).forEach(f=>f());}await Promise.resolve();}}
  await settle();assert(allText(tree).includes('AVAILABLE-ROW'));
  visible='hidden';timer();await settle();assert.equal(calls,1);
  rows=[{...rows[0],used_for_item_id:'registered-body'}];visible='visible';events.focus();await settle();assert(!allText(tree).includes('AVAILABLE-ROW'));assert.equal(calls,2);
  rows=[];timer();await settle();assert.equal(calls,3);
  hooks.forEach(h=>h?.cleanup?.());assert(!events.focus);assert(!events.visibilitychange);
 }
 console.log('Shared unused-only data, all pages, owner scope and both live lists removing allocated spares passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
