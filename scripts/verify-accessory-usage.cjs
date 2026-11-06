const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const compile=source=>ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const jsx=(type,props)=>({type,props});
function all(n,out=[]){if(!n||typeof n!=='object')return out;if(Array.isArray(n)){n.forEach(v=>all(v,out));return out;}out.push(n);all(n.props?.children,out);return out;}
(async()=>{
 const rpc=[];const transport={exports:{},require:()=>({getSupabase:()=>({rpc:async(name,args)=>{rpc.push({name,args});return{data:{item_id:'remote',serial:args.p_serial},error:null};}})})};
 vm.runInNewContext(compile(fs.readFileSync(path.join(root,'packages/shared/src/accessoryUsage.ts'),'utf8')),transport);
 await assert.rejects(transport.exports.reassignAccessoryUsage('remote','bad','rev'));assert.equal(rpc.length,0);
 await transport.exports.reassignAccessoryUsage('remote',' 2448B ','rev');
 assert.deepEqual(JSON.parse(JSON.stringify(rpc[0])),{name:'reassign_accessory_usage',args:{p_item_id:'remote',p_serial:'2448b',p_expected_revision:'rev'}});
 let cursor,hooks,effects,tree,dirty,writes,revision,finish,saved;
 const react={useState(v){const n=cursor++;if(!hooks[n])hooks[n]={value:typeof v==='function'?v():v};return[hooks[n].value,x=>{hooks[n].value=typeof x==='function'?x(hooks[n].value):x;dirty=true;}];},useRef(v){const n=cursor++;return hooks[n]??(hooks[n]={current:v});},useEffect(fn,deps){const n=cursor++;if(!hooks[n]||deps.some((v,i)=>v!==hooks[n].deps[i])){hooks[n]={deps};effects.push(fn);}}};
 const shared={CONDITIONS:[],MARKETPLACES:[],SALES_CHANNELS:[],STATUSES:[],deliveryStaffOptions:s=>s,
  fetchAccessoryUsage:async()=>({serial:'2447',sku:'2447-AAHH-date-161',revision}),
  reassignAccessoryUsage:(...args)=>{writes.push({type:'usage',args});return new Promise(resolve=>{finish=()=>resolve({serial:'2448'});});}
 };
 const api={fetchCards:async()=>[],fetchInventoryPaymentCard:async()=>null,updateInventoryItem:async(item,fields)=>{writes.push({type:'fields',fields});revision='after-edit';}};
const channelLabels={exports:{}};vm.runInNewContext(ts.transpileModule(fs.readFileSync('packages/shared/src/salesChannels.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,channelLabels);Object.assign(shared,channelLabels.exports);
 const ctx={exports:{},require:id=>id==='react'?react:id==='react/jsx-runtime'?{jsx,jsxs:jsx}:id==='@bussan/shared'?shared:id==='../api'?api:id==='../inventory'?{productSerial:()=> '2447'}:{default:'component'}};
 const source=fs.readFileSync(path.join(root,'apps/admin/src/pages/Inventory.tsx'),'utf8')+'\nexport {InventoryFullEditDialog};';
 vm.runInNewContext(compile(source),ctx);
 const props={item:{id:'remote',sku:'2447-AAHH-date-161',lot_seq:2447,is_accessory:true,memo:null,model_no:null,product_no:null},staff:[],canDelete:true,onClose(){},onSaved(){saved++;}};
 const flush=async()=>{for(let i=0;i<15;i++){if(dirty){cursor=0;dirty=false;tree=ctx.exports.InventoryFullEditDialog(props);effects.splice(0).forEach(fn=>fn());}await Promise.resolve();}};
 const mount=async()=>{cursor=0;hooks=[];effects=[];dirty=true;writes=[];saved=0;revision='initial-revision';await flush();};
 const field=label=>{const node=all(tree).find(n=>n.type==='label'&&all(n).some(c=>c.type==='span'&&c.props.children===label));assert(node,label);return all(node).find(n=>n.type==='input'||n.type==='textarea');};
 const save=()=>all(tree).find(n=>n.type==='button'&&n.props.children==='保存').props.onClick();
 await mount();assert.equal(field('利用記録').props.value,'2447');assert.equal(writes.length,0);
 assert(!all(tree).some(n=>n.type==='button'&&n.props.children==='利用記録を変更'));
 field('利用記録').props.onChange({target:{value:'2448'}});await flush();assert.equal(writes.length,0,'Typing must not save');
 save();save();assert.equal(writes.length,1,'One normal Save must perform one transfer');
 assert.equal(writes[0].type,'usage','Usage-only save must not overwrite shared parent fields');assert.deepEqual(writes[0].args,['remote','2448','initial-revision']);finish();await flush();assert.equal(saved,1);
 await mount();field('利用記録').props.onChange({target:{value:'2448'}});field('仕入担当者からのコメント').props.onChange({target:{value:'updated memo'}});await flush();save();await flush();
 assert.equal(writes[0].type,'fields');assert.equal(writes[0].fields.memo,'updated memo');assert.equal(writes[1].type,'usage');assert.equal(writes[1].args[2],'after-edit');finish();await flush();assert.equal(saved,1);
 await mount();field('利用記録').props.onChange({target:{value:'invalid'}});await flush();save();await flush();assert.equal(writes.length,0);assert(all(tree).some(n=>n.props?.role==='alert'));
 ctx.window={matchMedia:()=>({matches:true,addEventListener(){},removeEventListener(){}})};
 await mount();assert.equal(tree.props.role,'region');assert.equal(tree.props['aria-modal'],undefined,'Desktop sidebar must not block the inventory');
 assert.equal(field('仕入担当者からのコメント').props.rows,undefined,'Preserve comment textarea height settings');
 ctx.window={matchMedia:()=>({matches:false,addEventListener(){},removeEventListener(){}})};
 await mount();assert.equal(tree.props.role,'dialog');assert.equal(tree.props['aria-modal'],true);
 console.log('Inline photo-detail usage preserves saves and parent fields; desktop sidebar/mobile dialog and comment height settings passed');
})().catch(error=>{console.error(error);process.exitCode=1;});
