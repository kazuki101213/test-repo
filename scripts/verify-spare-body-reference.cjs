const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),assert=require('node:assert/strict');
const compile=path=>ts.transpileModule(fs.readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const inventory={exports:{}};vm.runInNewContext(compile('apps/admin/src/inventory.ts'),inventory);
const body={id:'body',sku:'2398-AAMM-20261004-1350',lot_seq:2398,is_accessory:false,title:'body',maker:'SHARP',purchaser_id:'AA',purchaser_name:'長部一輝',deliverer_id:'MM',deliverer_name:'株式会社吉光'};
const remote={...body,id:'remote',sku:'2398-EEMM-20260502-145',is_accessory:true,title:'リモコン',maker:null,purchaser_id:'EE',purchaser_name:'石川秀樹',cost_amount:1450};
const suffixBody={...body,id:'body-a',sku:'2398a-AAII-20261005-0',maker:'SONY',deliverer_id:'II',deliverer_name:'久保田真由'};
const suffixRemote={...remote,id:'remote-a',sku:'2398a-AAII-20261005-0',deliverer_id:'II'};
const dbRows=[body,remote,suffixBody,suffixRemote];
const db={from(table){const filters=[];const q={select(){return q},limit(){return q},eq(field,value){filters.push(row=>row[field]===value);return q},single(){return Promise.resolve({data:{marketplace_item_id:'source-id'},error:null})},then(resolve){return Promise.resolve({data:dbRows.filter(row=>filters.every(test=>test(row))),error:null}).then(resolve)}};return q}};
const api={exports:{},require:name=>name==='@bussan/shared'?{getSupabase:()=>db}:name==='./inventory'?inventory.exports:{}};
vm.runInNewContext(compile('apps/admin/src/api.ts'),api);
let hooks=[],cursor=0,pending=[],dirty=true,tree,saved;
const react={useState(initial){const n=cursor++;hooks[n]??={value:typeof initial==='function'?initial():initial};return[hooks[n].value,value=>{hooks[n].value=typeof value==='function'?value(hooks[n].value):value;dirty=true}]},useRef(value){return hooks[cursor++]??={current:value}},useCallback(fn,deps){const n=cursor++,old=hooks[n];if(!old||deps.some((v,i)=>v!==old.deps[i]))hooks[n]={value:fn,deps};return hooks[n].value},useEffect(fn,deps){const n=cursor++,old=hooks[n];if(!old||deps.some((v,i)=>v!==old.deps[i])){old?.cleanup?.();const entry=hooks[n]={deps};pending.push(()=>{entry.cleanup=fn()})}}};
const jsx=(type,props)=>({type,props});
const component={exports:{},require:name=>name==='react'?react:name==='react/jsx-runtime'?{jsx,jsxs:jsx}:name==='@bussan/shared'?{staffDisplayName:x=>x,deliveryStaffOptions:x=>x,MARKETPLACES:[],spareSearchFields:[{value:'title',label:'品名'}],fetchSpareAccessories:async()=>[],yen:x=>x,matchesSpareSearch:()=>true}:name==='../api'?{...api.exports,fetchStaff:async()=>[{id:'AA',name:'長部一輝'},{id:'EE',name:'石川秀樹'},{id:'MM',name:'株式会社吉光'}],createSpareAccessory:async input=>{saved=input}}:{default:'input'},window:{setInterval(){},clearInterval(){},addEventListener(){},removeEventListener(){}},document:{visibilityState:'visible',addEventListener(){},removeEventListener(){}}};
vm.runInNewContext(compile('apps/admin/src/pages/Spares.tsx'),component);
function all(node,out=[]){if(Array.isArray(node))node.forEach(n=>all(n,out));else if(node&&typeof node==='object'){out.push(node);all(node.props?.children,out)}return out}
async function settle(){for(let n=0;n<25;n++){if(dirty){cursor=0;dirty=false;tree=component.exports.default({me:{id:'AA',role:'admin'}});pending.splice(0).forEach(fn=>fn())}await Promise.resolve()}}
function field(label){const row=all(tree).find(n=>n.type==='label'&&all(n).some(child=>child.type==='span'&&child.props.children===label));return all(row).find(n=>n.type==='input')}
(async()=>{
 const source=await api.exports.findInventoryAccessoryForSpare('2398');assert.equal(source.maker,'SHARP');assert.equal(source.purchaser_id,'EE');assert.equal(source.cost_amount,1450);assert.equal(source.deliverer_id,'MM');
 const returned=await api.exports.findInventoryAccessoryForSpare('2398a');assert.equal(returned.id,'remote-a');assert.equal(returned.maker,'SONY');assert.equal(returned.deliverer_id,'II');
 await settle();all(tree).find(n=>n.type==='button'&&n.props.children==='予備を追加').props.onClick();await settle();
 const usage=field('利用記録（通番号）');usage.props.onChange({target:{value:'2398'}});await settle();await field('利用記録（通番号）').props.onBlur({target:{value:'2398'}});await settle();
 assert.equal(field('メーカー').props.value,'SHARP');
 await all(tree).find(n=>n.type==='form').props.onSubmit({preventDefault(){}});await settle();assert.equal(saved.owner_staff_id,'MM');assert.equal(saved.owner_name,'株式会社吉光');assert.equal(saved.manufacturer,'SHARP');
 console.log('Real API exact serial lookup, remote maker fallback, preserved purchase source, and real form delivery holder/maker passed');
})().catch(error=>{console.error(error);process.exitCode=1});
