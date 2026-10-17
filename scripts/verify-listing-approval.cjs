const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),assert=require('node:assert/strict'),path=require('node:path');
function load(file,imports={}){const c={exports:{},crypto:require('node:crypto').webcrypto,require:id=>imports[id]??{}};vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,c);return c.exports;}
const seller=load('packages/shared/src/seller.ts'),model=load('packages/shared/src/productModel.ts'),workflow=load('packages/shared/src/workflow.ts');
const description=load('apps/delivery/src/description.ts',{'./descriptionTemplates':load('apps/delivery/src/descriptionTemplates.ts')});
const {listingDraft}=load('apps/delivery/src/listingDraft.ts',{'@bussan/shared':{...seller,...model},'./description':description});
const base={id:'test',sku:'2407b-AAMM-20261012-1000',lot_seq:2407,title:'ブルーレイレコーダー',model_no:'DBR-W508',marketplace:'ヤフオク',sales_channel:'メルカリ',planned_price:15981,condition:'非常に良い',deliverer_name:'株式会社吉光',status:'商品登録前',inspected:true,cleaned:true};
for(const channel of ['メルカリ','ヤフオク']){
 const draft=listingDraft({...base,sales_channel:channel},'東芝',[base.sku,'2407b-AAMM-20261012-1001']);
 assert(draft.title.includes('【2407b】'));assert(draft.title.includes('DBR-W508'));assert(draft.title.includes('東芝'));
 assert(draft.description.includes('【'+base.sku+'】'));assert(draft.description.includes('【2407b-AAMM-20261012-1001】'));
 assert(!draft.description.startsWith('商品名（'));assert(draft.description.length>100);
 const saved='商品名（'+channel+'）\n手入力タイトル\n\n説明文\n手入力本文';
 const edited=listingDraft({...base,sales_channel:channel,description:saved},'東芝');assert.equal(edited.title,'手入力タイトル');assert.equal(edited.description,'手入力本文');
 const legacy=listingDraft({...base,sales_channel:channel,description:'保存した文章'},'東芝');
 assert.equal(legacy.description,'保存した文章');assert(legacy.title.includes('【2407b】'));assert(legacy.title.includes('東芝'));
}
const jsx=(type,props)=>({type,props}),react={useState:v=>[v,()=>{}],useRef:v=>({current:v})};
const Controls=load('apps/delivery/src/components/WorkflowControls.tsx',{'react':react,'react/jsx-runtime':{jsx,jsxs:jsx},'@bussan/shared':workflow}).default;
function all(n){return !n||typeof n!=='object'?[]:Array.isArray(n)?n.flatMap(all):[n,...all(n.props?.children)];}
for(const channel of ['FBA','自己発送','メルカリ','ヤフオク'])for(const approval of [undefined,false,true]){
 const tree=Controls({task:{...base,sales_channel:channel,photo_review_approved:approval},onChanged:async()=>{},onError:()=>{}});
 const button=all(tree).find(n=>['listing','listing_complete'].includes(n.props?.['data-action']));
 assert(button);assert.equal(button.props.disabled,approval!==true,channel+':'+approval);
 assert.equal(all(tree).find(n=>n.props?.['data-action']==='photos').props.disabled,false);
}
async function panelCheck(approved,saved){
 let cursor=0,hooks=[],pending=[],tree,dirty=true;
 const hookReact={useRef(v){return hooks[cursor++]??={current:v};},useState(v){const n=cursor++;hooks[n]??={value:v};return[hooks[n].value,next=>{hooks[n].value=typeof next==='function'?next(hooks[n].value):next;dirty=true;}];},useEffect(fn,deps){const n=cursor++;if(!hooks[n]||deps.some((v,i)=>v!==hooks[n].deps[i])){hooks[n]={deps};pending.push(fn);}}};
 const Panel=load('apps/delivery/src/components/SellerPanel.tsx',{'react':hookReact,'react/jsx-runtime':{jsx,jsxs:jsx},'@bussan/shared':{...seller,canViewDeliveryAssignee:()=>false},'../listingDraft':{listingDraft},'../api':{
  fetchTask:async()=>({...base,description:saved}),fetchSellerContext:async()=>({revision:'one',operations:[],photo_review_approved:approved}),fetchPhotoUrls:async()=>[{id:'one',url:'photo'}],fetchProductMaker:async()=>'東芝'
 }}).default;
 const props={mode:'listing',task:{...base,photo_review_approved:approved},staff:{id:'MM',name:'株式会社吉光'},listingSkus:[base.sku],onChanged(){},onClose(){}};
 for(let i=0;i<25;i++){if(dirty){cursor=0;dirty=false;tree=Panel(props);pending.splice(0).forEach(fn=>fn());}await Promise.resolve();}
 const title=all(tree).find(n=>n.type==='input'&&n.props.maxLength===128);
 const body=all(tree).find(n=>n.type==='textarea'&&n.props.maxLength===5000);
 assert(title&&body);assert.equal(title.props.disabled,!approved);
 assert.equal(body.props.value,saved?'保存済み本文':listingDraft(base,'東芝',[base.sku]).description);
 assert.equal(title.props.value,saved?'保存済みタイトル':listingDraft(base,'東芝',[base.sku]).title);
}
(async()=>{await panelCheck(false,null);await panelCheck(true,null);await panelCheck(true,'商品名（メルカリ）\n保存済みタイトル\n\n説明文\n保存済み本文');console.log('PASS: four-channel approval gate, listing-panel generation, family SKUs and saved edits');})().catch(error=>{console.error(error);process.exitCode=1;});
