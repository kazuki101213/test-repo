const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),assert=require('node:assert/strict');
function load(file,imports){const c={exports:{},require:id=>imports?.[id]??{}};vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,c);return c.exports;}
const model=load('packages/shared/src/productModel.ts'),seller=load('packages/shared/src/seller.ts',{'./productCategory':load('packages/shared/src/productCategory.ts')});
const description=load('apps/delivery/src/description.ts',{'./descriptionTemplates':load('apps/delivery/src/descriptionTemplates.ts')});
const {listingDraft}=load('apps/delivery/src/listingDraft.ts',{'@bussan/shared':{...seller,...model,...load('packages/shared/src/productCategory.ts')},'./description':description});
const damagedSaved={id:'damage',sku:'2403-test',lot_seq:2403,title:'DBR-T1009',model_no:'DBR-T1009',marketplace:'ヤフオク',sales_channel:'ヤフオク',condition:'可',description:'商品名（ヤフオク）\n保存した商品名\n\n説明文\n手編集の本文',has_physical_damage:true};
const damagedDraft=listingDraft(damagedSaved,'TOSHIBA');assert.equal(damagedDraft.description,'手編集の本文\nはそんがあります。');assert.equal(damagedDraft.title,'保存した商品名');
assert.equal(description.withReportedDamage(damagedDraft.description,true),damagedDraft.description);
assert.equal(description.withReportedDamage('手編集の本文',false),'手編集の本文');
function all(n){return !n||typeof n!=='object'?[]:Array.isArray(n)?n.flatMap(all):[n,...all(n.props?.children)];}
const jsx=(type,props)=>({type,props});
async function check(channel,overrides={}){
 let hooks=[],cursor=0,effects=[],tree,saved,saveCalls=0,saving=false;
 const task={id:'item',sku:'2407b-AAII-test',lot_seq:2407,title:'ブルーレイレコーダー',model_no:'DBR-W508',sales_channel:channel,condition:'非常に良い',accessories:'リモコン',marketplace:'ヤフオク',inspected:true,cleaned:true,description:null,...overrides};
 const react={useState(initial){const n=cursor++;hooks[n]??={value:typeof initial==='function'?initial():initial};return[hooks[n].value,next=>{hooks[n].value=typeof next==='function'?next(hooks[n].value):next;}];},useEffect(fn,deps){const n=cursor++;if(!hooks[n]||deps.some((v,i)=>v!==hooks[n].deps[i])){hooks[n]={deps};effects.push(fn);}}};
 const Editor=load('apps/delivery/src/components/DescriptionEditor.tsx',{'react':react,'react/jsx-runtime':{jsx,jsxs:jsx},'@bussan/shared':model,'../description':description,'../useListingKeywords':{useListingKeywords:()=>({busy:false,message:'',generate:async()=>{}})},'./ColoredSelect':{default:'select'},'../api':{fetchProductMaker:async()=>{throw Error('Duplicate lookup');},saveDeliveryDescription:async(id,input)=>{saved=input;saveCalls++;}}}).default;
 const embedded={value:listingDraft(task,'東芝',[task.sku]),manufacturer:'東芝',disabled:false,onSaving:v=>{saving=v;},onChange:value=>{embedded.value={...embedded.value,...value};}};
 const props={task,listingSkus:[task.sku],embedded,onSaved:async()=>{}};
 async function render(){for(let i=0;i<8;i++){cursor=0;tree=Editor(props);effects.splice(0).forEach(fn=>fn());await Promise.resolve();}}
 await render();
 const body=()=>all(tree).find(n=>n.type==='textarea'&&n.props.maxLength!==2000);
 assert(body());assert.equal(all(tree).filter(n=>n.type==='textarea'&&n.props.maxLength!==2000).length,1);
 body().props.onChange({target:{value:'編集した本文'}});await render();assert.equal(embedded.value.description,'編集した本文');
 if(channel==='メルカリ'||channel==='ヤフオク'){
  const maker=all(tree).find(n=>n.type==='input'&&n.props.placeholder==='商品リストから取得・必要に応じて修正');maker.props.onChange({target:{value:'メーカー修正'}});await render();assert(embedded.value.title.includes('メーカー修正'));if(overrides.title)assert(embedded.value.title.includes(overrides.title),'regeneration retains the known product name');assert(embedded.value.description.includes('【'+task.sku+'】'));
  body().props.onChange({target:{value:'最終の本文'}});await render();
 }
 tree.props.onSubmit({preventDefault(){}});assert(saving);for(let i=0;i<15;i++)await Promise.resolve();assert.equal(saveCalls,1);assert.equal(saving,false);
 assert(saved.description.includes(embedded.value.description));
 if(channel==='メルカリ'||channel==='ヤフオク')assert(saved.description.includes(embedded.value.title));
}
(async()=>{for(const channel of ['メルカリ','ヤフオク','FBA','自己発送'])await check(channel);await check('メルカリ',{title:'RODE VideoMic GO',model_no:null,marketplace:'動作品Amazon返品'});console.log('PASS: unified description field, generated and edited content, saved payload, four channels and save locking');})().catch(error=>{console.error(error);process.exitCode=1;});
