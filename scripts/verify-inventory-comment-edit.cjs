const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),assert=require('node:assert/strict');
let hooks=[],cursor=0,dirty=true,pending=[],tree,component,props,saved;
const react={useState(initial){const i=cursor++;hooks[i]??={value:typeof initial==='function'?initial():initial};return[hooks[i].value,value=>{hooks[i].value=typeof value==='function'?value(hooks[i].value):value;dirty=true;}];},useEffect(fn,deps){const i=cursor++;if(!hooks[i]||deps.some((d,j)=>d!==hooks[i].deps[j])){hooks[i]?.cleanup?.();const h=hooks[i]={deps};pending.push(()=>{h.cleanup=fn();});}}};
const jsx=(type,props)=>({type,props});
const api={fetchCards:async()=>[],fetchInventoryPaymentCard:async()=>null,updateInventoryField:async(item,field,value)=>{saved={item,field,value};},updateInventoryItem:async(item,fields)=>{saved={item,fields};}};
const shared={CONDITIONS:[],MARKETPLACES:[],SALES_CHANNELS:[],STATUSES:[],deliveryStaffOptions:s=>s};
const source=fs.readFileSync('apps/admin/src/pages/Inventory.tsx','utf8')+'\nexport {InventoryFieldDialog,InventoryFullEditDialog};';
const context={exports:{},require:name=>name==='react'?react:name==='react/jsx-runtime'?{jsx,jsxs:jsx}:name==='@bussan/shared'?shared:name==='../api'?api:{default:'component'}};
vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,context);
function all(n,out=[]){if(!n||typeof n!=='object')return out;if(Array.isArray(n)){n.forEach(v=>all(v,out));return out;}out.push(n);all(n.props?.children,out);return out;}
async function settle(){for(let i=0;i<12;i++){if(dirty){cursor=0;dirty=false;tree=component(props);pending.splice(0).forEach(fn=>fn());}await Promise.resolve();}}
function field(label){const n=all(tree).find(n=>n.type==='label'&&all(n).some(c=>c.type==='span'&&c.props.children===label));assert(n,label);return all(n).find(n=>['input','textarea'].includes(n.type));}
async function mount(name){hooks=[];pending=[];dirty=true;saved=null;component=context.exports[name];props={item:{id:'item',sku:'123-AA-0',lot_seq:123,model_no:null,product_no:null,memo:null},field:'memo',staff:[],onClose(){},onSaved(){}};await settle();}
(async()=>{
 await mount('InventoryFieldDialog');assert.equal(field('仕入担当者からのコメント').props.value,'');
 field('仕入担当者からのコメント').props.onChange({target:{value:'新しいコメント\n2行目'}});await settle();
 await all(tree).find(n=>n.type==='button'&&n.props.children==='保存').props.onClick();await settle();
 assert.equal(saved.field,'memo');assert.equal(saved.value,'新しいコメント\n2行目');
 await mount('InventoryFullEditDialog');assert.equal(tree.props['aria-label'],'商品情報編集');
 assert.equal(field('SKU').props.type,'text');assert.equal(field('型番').props.type,'text');
 assert.equal(field('仕入担当者からのコメント').props.value,'');
 field('仕入担当者からのコメント').props.onChange({target:{value:'空欄から保存'}});await settle();
 const save=all(tree).find(n=>n.type==='button'&&n.props.children==='保存');assert.equal(save.props.disabled,false);await save.props.onClick();await settle();
 assert.equal(saved.fields.memo,'空欄から保存');assert.equal(saved.item.id,'item');
 console.log('Empty purchaser comments are editable and saved through both field and full product dialogs');
})().catch(e=>{console.error(e);process.exitCode=1;});
