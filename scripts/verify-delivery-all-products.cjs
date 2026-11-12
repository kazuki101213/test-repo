const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),assert=require('node:assert/strict');
const jsx=(type,props)=>({type,props}),nodes=n=>!n||typeof n!=='object'?[]:Array.isArray(n)?n.flatMap(nodes):[n,...nodes(n.props?.children)];
const compile=file=>ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const buyerNames={exports:{}};vm.runInNewContext(compile('packages/shared/src/staffNames.ts'),buyerNames);
function hooks(){let cursor=0,values=[];return{reset(){cursor=0;},react:{useState(v){const i=cursor++;if(!values[i])values[i]={value:typeof v==='function'?v():v};return[values[i].value,next=>values[i].value=typeof next==='function'?next(values[i].value):next];},useRef(v){return values[cursor++]??={current:v};},useEffect(){},useMemo:f=>f(),useCallback:f=>f,lazy:f=>f,Suspense:()=>{}}};}
const staff={id:'own',code:'DD',role:'deliverer',name:'DD'},own={id:'one',sku:'100-EEDD-date',status:'検品中',deliverer_id:'own',title:'own',is_accessory:false},other={...own,id:'two',sku:'101-EEHH-date',deliverer_id:'other',deliverer_name:'HH',title:'other'};
const shared={STATUSES:['受取前','検品中','Amazon返送依頼','Amazon補填申請中','商品登録前','出品中','取引中','販売済','返品処理','動作不良'],canViewDeliveryAssignee:s=>s.role==='admin',deliveryStaffOptions:rows=>rows,inventoryPurchaserOptions:buyerNames.exports.inventoryPurchaserOptions,staffDisplayName:v=>v,matchesInventoryFilters:()=>true,jpDate:v=>v,productModelText:t=>t.title};
const presentation={exports:{}};vm.runInNewContext(ts.transpileModule(fs.readFileSync('packages/shared/src/inventoryPresentation.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,presentation);Object.assign(shared,presentation.exports);const notices={exports:{},URL};vm.runInNewContext(ts.transpileModule(fs.readFileSync('packages/shared/src/noticeUrl.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,notices);Object.assign(shared,notices.exports);
const TaskCard=()=>{},rt=hooks();let scope,filters,extraRows=[];
const channelLabels={exports:{}};vm.runInNewContext(ts.transpileModule(fs.readFileSync('packages/shared/src/salesChannels.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,channelLabels);Object.assign(shared,channelLabels.exports);
const context={exports:{},URLSearchParams,window:{location:{search:''}},require:id=>id==='react'?rt.react:id==='react/jsx-runtime'?{jsx,jsxs:jsx}:id==='@bussan/shared'?shared:id.endsWith('/TaskCard')?{default:TaskCard}:id.endsWith('/useTaskViewport')?{useTaskViewport:()=>({})}:id.endsWith('/useInventoryPage')?{useInventoryPage:(value,owner,f)=>{scope=value;filters=f;return{rows:[...(value==='delivery'?[own]:[own,other]),...extraRows].filter(row=>(f.status==='all'||row.status===f.status)&&(!f.states.status?.length||f.states.status.includes(row.status))),total:value==='delivery'?1:2,loading:false,updateRow(){}};}}:id.endsWith('/deliverySearch')?{normalizeSearch:v=>v,deliverySearchFields:[{label:'通番号',value:'serial'}],matchesDeliverySearch:()=>true,deliverySearchValue:()=>''}: {default:()=>{},deliveryErrorMessage:String}};
vm.runInNewContext(compile('apps/delivery/src/pages/TaskList.tsx'),context);
const render=()=>{rt.reset();return context.exports.default({staff});},button=(tree,label)=>nodes(tree).find(n=>n.type==='button'&&(n.props.children===label||nodes(n.props.children).some(child=>child.props?.children===label)));
let tree=render();assert.equal(scope,'delivery');assert.equal(filters.status,'all');assert.deepEqual(Array.from(filters.states.status),['受取前','検品中','商品登録前']);button(tree,'全商品').props.onClick();tree=render();assert.equal(scope,'delivery-all');assert.equal(filters.status,'all');assert.equal(filters.query,'');assert.equal(filters.delivererIds.length,0);
function assertOnlyCatalogSelected(tree){assert.equal(button(tree,'全商品').props['aria-pressed'],true);for(const node of nodes(tree).filter(n=>n.type==='button'&&n.props['data-status'])){assert.equal(node.props['aria-pressed'],false,'All products must not also select '+node.props['data-status']);assert.equal(node.props['data-active'],false,'The visual selection must match aria-pressed');}}
assertOnlyCatalogSelected(tree);
let cards=nodes(tree).filter(n=>n.type===TaskCard);assert.equal(cards.length,2);assert.equal(cards[0].props.readOnly,true);assert.equal(cards[1].props.readOnly,true);assert.equal(cards[1].props.showAssignee,true);
assert.ok(!button(tree,'表示中を選択'));assert.ok(!button(tree,'選択解除'));button(tree,'全商品').props.onClick();tree=render();assert.equal(scope,'delivery');
assert.ok(!button(tree,'表示中を選択'));assert.ok(!button(tree,'選択解除'));
for(const status of ['work','selling','販売済','動作不良','Amazon返送依頼','Amazon補填申請中','返品処理','all']) {button(tree,'全商品').props.onClick();tree=render();assert.equal(scope,'delivery-all');const stateButton=nodes(tree).find(n=>n.type==='button'&&n.props['data-status']===status);assert.ok(stateButton);stateButton.props.onClick();tree=render();assert.equal(scope,'delivery','Every state button exits the all-products catalog');assert.equal(filters.status,['work','selling'].includes(status)?'all':status);assert.equal(button(tree,'全商品').props['aria-pressed'],false);assert.equal(nodes(tree).find(n=>n.type==='button'&&n.props['data-status']===status).props['aria-pressed'],true);assert.ok(!nodes(tree).some(n=>n.type===TaskCard&&n.props.task.id==='two'),'Other assignees leave the catalog when a state is chosen');}
// Every underlying status remains distinct; the two buttons select exact server-side groups.
extraRows=shared.STATUSES.map((status,i)=>({...own,id:'state-'+i,sku:(300+i)+'-EEDD-date',status}));
for(const [label,statuses] of [['作業中',['受取前','検品中','商品登録前']],['販売中',['出品中','取引中']]]) {
  tree=render();button(tree,label).props.onClick();tree=render();
  assert.deepEqual(Array.from(filters.states.status),statuses);
  const displayed=nodes(tree).filter(n=>n.type===TaskCard).map(n=>n.props.task.status);
  assert.deepEqual([...new Set(displayed)].sort(),[...statuses].sort());
  assert.ok(displayed.every(status=>shared.STATUSES.includes(status)));
}
const detailedFilter=()=>nodes(tree).find(n=>typeof n.type==='function'&&n.props.value&&n.props.onChange);
button(tree,'全商品').props.onClick();tree=render();
assert.equal(scope,'delivery-all');
assert.equal(detailedFilter().props.assignee,undefined);
detailedFilter().props.purchaser.onChange(['AA','EE']);tree=render();
assert.deepEqual(Array.from(filters.purchaserIds),['AA','EE']);
button(tree,'全て解除').props.onClick();tree=render();
assert.equal(filters.purchaserIds.length,0);
button(tree,'全商品').props.onClick();tree=render();
const searchGroup=nodes(tree).find(n=>n.props['aria-label']==='在庫検索');
const filterControls=nodes(searchGroup).find(n=>n.props.className==='delivery-inventory-filter-controls');
assert.equal(filterControls.props.children[0],detailedFilter());
assert.equal(filterControls.props.children[1].props['aria-label'],'仕入日の期間');
assert.equal(filterControls.props.children[2],button(tree,'全て解除'));
detailedFilter().props.onChange({status:['検品中','販売済'],marketplace:['ヤフオク']});tree=render();
button(tree,'作業中').props.onClick();tree=render();assert.deepEqual(Array.from(filters.states.status),['検品中']);assert.deepEqual(Array.from(filters.states.marketplace),['ヤフオク']);
detailedFilter().props.onChange({status:['販売済']});tree=render();button(tree,'販売中').props.onClick();tree=render();assert.equal(filters.status,'出品中');assert.deepEqual(Array.from(filters.states.status),['販売済']);assert.equal(nodes(tree).filter(n=>n.type===TaskCard).length,0,'Disjoint group and detailed state return no inventory');
const change=(label,value)=>nodes(tree).find(n=>n.props['aria-label']===label).props.onChange({target:{value}});
change('検索項目','sku');tree=render();change('在庫を検索','100');tree=render();
change('仕入日・開始日','2026-11-01');tree=render();change('仕入日・終了日','2026-11-09');tree=render();
assert.equal(filters.from,'2026-11-01');assert.equal(filters.to,'2026-11-09');assert.equal(filters.query,'100');
button(tree,'全て解除').props.onClick();tree=render();
assert.equal(scope,'delivery');assert.equal(filters.status,'all');assert.equal(Object.keys(filters.states).length,0);
assert.equal(filters.from,'');assert.equal(filters.to,'');assert.equal(filters.query,'');assert.equal(filters.queryField,'serial');
button(tree,'全商品').props.onClick();tree=render();change('仕入日・開始日','2026-11-01');tree=render();
button(tree,'全て解除').props.onClick();tree=render();assertOnlyCatalogSelected(tree);assert.equal(scope,'delivery-all');assert.equal(filters.from,'');
extraRows=[];
const cardHooks=hooks(),WorkflowControls=()=>{},detail=()=>{},cardContext={exports:{},URL,URLSearchParams,window:{location:{search:''}},require:id=>id==='react'?cardHooks.react:id==='react/jsx-runtime'?{jsx,jsxs:jsx}:id==='@bussan/shared'?shared:id.endsWith('/WorkflowControls')?{default:WorkflowControls}:id.endsWith('/TaskDetail')?{default:detail}:{}};
vm.runInNewContext(compile('apps/delivery/src/components/TaskCard.tsx'),cardContext);
const card=readOnly=>{cardHooks.reset();return cardContext.exports.default({task:other,members:[other],staff:{...staff,role:'admin'},readOnly,showAssignee:true,amazonImageUrl:null,originalMarketplaceIds:new Map(),unreadItemIds:new Set(),expandedId:'two',onDetailOpened(){},onOpen(){},onClose(){},onOpenMember(){},onTaskChange(){}});};
tree=card(true);assert.ok(!nodes(tree).some(n=>n.type===WorkflowControls||n.type===detail));assert.ok(!nodes(tree).some(n=>n.type==='input'&&n.props.type==='checkbox'));assert.ok(nodes(tree).find(n=>n.props?.className==='task-card-photo-button').props.disabled);tree=card(false);assert.ok(nodes(tree).some(n=>n.type===WorkflowControls));assert.ok(!nodes(tree).some(n=>n.type==='input'&&n.props.type==='checkbox'));
console.log('All-products toggle retains scope and read-only controls; inventory selection buttons and checkboxes are absent.');
