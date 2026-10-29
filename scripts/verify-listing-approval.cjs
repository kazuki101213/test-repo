const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),assert=require('node:assert/strict'),path=require('node:path');
const testTimers=[];
function load(file,imports={}){const c={exports:{},crypto:require('node:crypto').webcrypto,document:{visibilityState:'visible'},window:{confirm:()=>true,setInterval:fn=>{testTimers.push(fn);return testTimers.length;},clearInterval:()=>{}},require:id=>imports[id]??{}};vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,c);return c.exports;}
const seller=load('packages/shared/src/seller.ts',{'./productCategory':load('packages/shared/src/productCategory.ts')}),model=load('packages/shared/src/productModel.ts'),workflow=load('packages/shared/src/workflow.ts');
const description=load('apps/delivery/src/description.ts',{'./descriptionTemplates':load('apps/delivery/src/descriptionTemplates.ts')});
const {listingDraft}=load('apps/delivery/src/listingDraft.ts',{'@bussan/shared':{...seller,...model,...load('packages/shared/src/productCategory.ts')},'./description':description});
const base={id:'test',sku:'2407b-AAMM-20261012-1000',lot_seq:2407,title:'ブルーレイレコーダー',model_no:'DBR-W508',marketplace:'ヤフオク',sales_channel:'メルカリ',planned_price:15981,condition:'非常に良い',deliverer_name:'株式会社吉光',status:'商品登録前',inspected:true,cleaned:true};
for(const channel of ['メルカリ','ヤフオク']){
 const draft=listingDraft({...base,sales_channel:channel},'東芝',[base.sku,'2407b-AAMM-20261012-1001']);
 assert(draft.title.includes('【2407b】'));assert(draft.title.includes('DBR-W508'));assert(draft.title.includes('東芝'));
 assert(draft.description.includes('【'+base.sku+'】'));assert(draft.description.includes('【2407b-AAMM-20261012-1001】'));
 assert(!draft.description.startsWith('商品名（'));assert(draft.description.length>100);
 const saved='商品名（'+channel+'）\n手入力タイトル\n\n説明文\n手入力本文';
 const edited=listingDraft({...base,sales_channel:channel,description:saved},'東芝');assert.equal(edited.title,'手入力タイトル');assert.equal(edited.description,'手入力本文');
 const foreign='商品名（'+(channel==='ヤフオク'?'メルカリ':'ヤフオク')+'）\n別の販売先のタイトル\n\n説明文\n別の販売先の本文';
 const switched=listingDraft({...base,sales_channel:channel,description:foreign},'東芝',[base.sku,'2407b-AAMM-20261012-1001']);assert.equal(switched.description,draft.description);assert.equal(switched.title,draft.title);
 const legacy=listingDraft({...base,sales_channel:channel,description:'保存した文章'},'東芝');
 assert.equal(legacy.description,'保存した文章');assert(legacy.title.includes('【2407b】'));assert(legacy.title.includes('東芝'));
}
// BDP players share the app's recorder group, including saved description drafts.
for(const saved of [null,'商品名（メルカリ）\n【2410】BDP-S6700 SONY\n\n説明文\n保存済み本文']){
 const draft=listingDraft({...base,title:'BDP-S6700',model_no:'BDP-S6700',description:saved},'SONY');
 assert.equal(draft.category,'ブルーレイレコーダー');assert.equal(draft.listingCategory,'ブルーレイレコーダー');assert.equal(draft.size,'100');
 if(saved)assert.equal(draft.description,'保存済み本文');
}
const ubp=listingDraft({...base,title:'UBP-X700',model_no:'UBP-X700',description_template:'小物',description:'商品名（メルカリ）\n保存済み名\n\n説明文\n保存済み本文'},'SONY');assert.equal(ubp.category,'ブルーレイレコーダー');assert.equal(ubp.listingCategory,'ブルーレイレコーダー');assert.equal(ubp.description,'保存済み本文');
const jsx=(type,props)=>({type,props}),react={useState:v=>[v,()=>{}],useRef:v=>({current:v})};
const Controls=load('apps/delivery/src/components/WorkflowControls.tsx',{'react':react,'react/jsx-runtime':{jsx,jsxs:jsx},'@bussan/shared':workflow}).default;
function all(n){return !n||typeof n!=='object'?[]:Array.isArray(n)?n.flatMap(all):[n,...all(typeof n.type==='function'?n.type(n.props):n.props?.children)];}
for(const channel of ['FBA','自己発送','メルカリ','ヤフオク'])for(const approval of [undefined,false,true]){
 const tree=Controls({task:{...base,sales_channel:channel,photo_review_approved:approval},onChanged:async()=>{},onError:()=>{}});
 const button=all(tree).find(n=>['listing','listing_complete'].includes(n.props?.['data-action']));
 assert(button);assert.equal(button.props.disabled,approval!==true,channel+':'+approval);
 assert.equal(all(tree).find(n=>n.props?.['data-action']==='photos').props.disabled,false);
}
async function panelCheck(approved,saved,uncertain=false,channel='メルカリ'){
 let cursor=0,hooks=[],pending=[],tree,dirty=true,queued,checks=0,finished=false,changed=[];const checkOperation=()=>({id:'uncertain-op',kind:'listing',status:finished?'succeeded':'uncertain',created_at:'2026-01-01T00:00:00Z',result:checks&&!finished?{read_check_state:'queued',read_check_requested_at:new Date().toISOString()}:{}});
 const hookReact={useRef(v){return hooks[cursor++]??={current:v};},useState(v){const n=cursor++;hooks[n]??={value:v};return[hooks[n].value,next=>{hooks[n].value=typeof next==='function'?next(hooks[n].value):next;dirty=true;}];},useEffect(fn,deps){const n=cursor++;if(!hooks[n]||deps.some((v,i)=>v!==hooks[n].deps[i])){const previous=hooks[n];hooks[n]={deps};pending.push(()=>{previous?.cleanup?.();hooks[n].cleanup=fn();});}}};
 const Panel=load('apps/delivery/src/components/SellerPanel.tsx',{'react':hookReact,'react/jsx-runtime':{jsx,jsxs:jsx},'@bussan/shared':{...seller,canViewDeliveryAssignee:()=>false},'./DescriptionEditor':{default:({embedded})=>jsx('div',{children:[jsx('input',{maxLength:128,value:embedded.value.title,disabled:embedded.disabled}),jsx('textarea',{maxLength:5000,value:embedded.value.description,disabled:embedded.disabled})]})},'../listingDraft':{listingDraft},'../api':{
  fetchTask:async()=>{for(let i=0;i<4;i++)await Promise.resolve();return {...base,sales_channel:channel,description:saved,status:finished?'出品中':base.status};},fetchSellerContext:async()=>({revision:'one',operations:uncertain?[checkOperation()]:[],photo_review_approved:approved}),fetchPhotoUrls:async()=>[1,2,3].map(n=>({id:String(n),url:'photo'+n})),fetchProductMaker:async()=>'東芝',requestListingResultCheck:async id=>{assert.equal(id,base.id);checks++;},fetchSellerOperation:async()=>{throw Error('Extra polling RPC');},queueSellerOperation:async(id,kind,payload)=>{queued={id,kind,payload};}
 }}).default;
 const props={mode:'listing',task:{...base,sales_channel:channel,photo_review_approved:approved},staff:{id:'MM',name:'株式会社吉光'},listingSkus:[base.sku],onChanged(task){changed.push(task);},onClose(){}};
 async function settle(){for(let i=0;i<25;i++){if(dirty){cursor=0;dirty=false;tree=Panel(props);pending.splice(0).forEach(fn=>fn());}await Promise.resolve();}}
 await settle();
 if(approved&&!uncertain){const field=all(tree).find(n=>n.type==='input'&&n.props.maxLength===200),original=field.props.value;field.props.onChange({target:{value:' '}});await settle();assert.equal(all(tree).find(n=>n.type==='button'&&n.props.children==='出品').props.disabled,true);assert(all(tree).some(n=>n.props?.role==='alert'&&String(n.props.children).includes('出品カテゴリを入力')));assert.equal(queued,undefined);field.props.onChange({target:{value:original}});await settle();}
 if(channel==='ヤフオク'&&approved&&!uncertain){const field=all(tree).find(n=>n.type==='input'&&n.props.maxLength===200),original=field.props.value;field.props.onChange({target:{value:'ブルーレイレコーダー'}});await settle();assert.equal(all(tree).find(n=>n.type==='button'&&n.props.children==='出品').props.disabled,true);assert(all(tree).some(n=>n.props?.role==='alert'&&String(n.props.children).includes('メーカーまで指定')));field.props.onChange({target:{value:original}});await settle();}
 assert.equal(all(tree).some(n=>n.type==='button'&&n.props.children==='閉じる'),false);
 const title=all(tree).find(n=>n.type==='input'&&n.props.maxLength===128);
 const body=all(tree).find(n=>n.type==='textarea'&&n.props.maxLength===5000);
 assert(title&&body);assert.equal(title.props.disabled,!approved||uncertain);
 assert.equal(body.props.value,saved?'保存済み本文':listingDraft({...base,sales_channel:channel},'東芝',[base.sku]).description);
 assert.equal(title.props.value,saved?'保存済みタイトル':listingDraft({...base,sales_channel:channel},'東芝',[base.sku]).title);
 const button=name=>all(tree).find(n=>n.type==='button'&&n.props['aria-label']===name);
 assert.equal(button('写真1を前へ').props.disabled,true);assert.equal(button('写真3を後へ').props.disabled,true);
 assert.equal(button('写真2を前へ').props.disabled,!approved||uncertain);
 if(uncertain){
  const named=name=>all(tree).find(n=>n.type==='button'&&n.props.children===name);
  assert.equal(named('出品').props.disabled,true);assert.equal(named('出品結果を確認').props.disabled,false);
  await named('出品結果を確認').props.onClick();await settle();assert.equal(checks,1);assert.equal(queued,undefined);assert.equal(named('出品結果を確認').props.disabled,true);
  finished=true;testTimers.at(-1)();await settle();assert.equal(named('出品結果を確認'),undefined);assert.equal(queued,undefined);assert.equal(changed.length,1,'Result confirmation must update the stock card before ending the effect');assert.equal(changed[0].status,'出品中');return;
 }
 if(channel==='ヤフオク'){
  const weight=all(tree).find(n=>n.type==='label'&&all(n).some(child=>child==='梱包後の重さ'||child?.props?.children==='梱包後の重さ'))||all(tree).find(n=>n.type==='label'&&Array.isArray(n.props?.children)&&n.props.children[0]==='梱包後の重さ');
  assert(weight,'Buyer-paid postal shipping must expose the packed weight');const select=all(weight).find(n=>n.type==='select');assert(select);
  const named=()=>all(tree).find(n=>n.type==='button'&&n.props.children==='出品');assert.equal(select.props.value,'5','Recorder weight defaults to 5kg');assert.equal(named().props.disabled,false);select.props.onChange({target:{value:''}});await settle();assert.equal(named().props.disabled,true,'Clearing weight blocks publish before queue');assert.equal(queued,undefined);
    select.props.onChange({target:{value:'10'}});await settle();assert.equal(named().props.disabled,false);
  const embedded=()=>all(tree).find(n=>n.props?.embedded)?.props.embedded;
  embedded().onChange({description:'手入力本文',category:'ブルーレイレコーダー'});await settle();assert.equal(embedded().value.weightKg,'10','Same category edits retain manual weight');
  embedded().onChange({category:'小物'});await settle();assert.equal(embedded().value.weightKg,'2');
  embedded().onChange({category:'モニター'});await settle();assert.equal(embedded().value.weightKg,'5');assert.equal(queued,undefined,'Weight and category selection never queues a listing');return;
 }
 if(approved&&!saved){
  const order=()=>all(tree).filter(n=>n.props?.className==='seller-photo').map(n=>all(n).find(child=>child.type==='img').props.src);
  button('写真3を前へ').props.onClick();await settle();assert.deepEqual(order(),['photo1','photo3','photo2']);
  button('写真1を後へ').props.onClick();await settle();assert.deepEqual(order(),['photo3','photo1','photo2']);
  all(tree).find(n=>n.props?.['aria-label']==='2枚目を出品に含める').props.onChange({target:{checked:false}});await settle();
  assert.deepEqual(order(),['photo3','photo2','photo1']);
  all(tree).find(n=>n.props?.['aria-label']==='この写真を出品に含める').props.onChange({target:{checked:true}});await settle();
  const publish=all(tree).find(n=>n.type==='button'&&n.props.children==='出品');assert.equal(publish.props.disabled,false);
  publish.props.onClick();await settle();assert.equal(queued,undefined,'Opening confirmation must not publish');let modal=all(tree).find(n=>n.props?.title==='出品しますか。');assert(modal);modal.props.onCancel();await settle();assert.equal(queued,undefined);publish.props.onClick();await settle();modal=all(tree).find(n=>n.props?.title==='出品しますか。');modal.props.onConfirm('2026-10-20');modal.props.onConfirm('2026-10-20');await settle();assert.equal(queued.kind,'listing');assert.deepEqual(Array.from(queued.payload.photos),['photo3','photo2','photo1']);
 }
}
(async()=>{await panelCheck(true,null,false,'ヤフオク');await panelCheck(true,null,true);await panelCheck(false,null);await panelCheck(true,null);await panelCheck(true,'商品名（メルカリ）\n保存済みタイトル\n\n説明文\n保存済み本文');console.log('PASS: four-channel approval gate, listing-panel generation, family SKUs and saved edits');})().catch(error=>{console.error(error);process.exitCode=1;});


for(const description of [null,'商品名（ヤフオク）\n保存済み名\n\n説明文\n保存済み本文']){const d=listingDraft({...base,title:'BDP-S6700',model_no:'BDP-S6700',sales_channel:'ヤフオク',description},'SONY');assert.equal(d.listingCategory,'ブルーレイレコーダー > ソニー');if(description)assert.equal(d.description,'保存済み本文');}
