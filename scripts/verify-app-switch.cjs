const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),assert=require('node:assert/strict');
const compile=file=>ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
const jsx=(type,props)=>({type,props});
function all(n,out=[]){if(Array.isArray(n))n.forEach(v=>all(v,out));else if(n&&typeof n==='object'){out.push(n);all(n.props?.children,out)}return out}
function text(n){return n==null?'':Array.isArray(n)?n.map(text).join(''):typeof n==='object'?text(n.props?.children):String(n)}
const storage=new Map(),history=[],destinations=[];let reloads=0;
const location={href:'https://test-repo-delivery.vercel.app/?v=keep&taskKind=invoice&itemId=old#bid-calculator',reload(){reloads++},assign:url=>destinations.push(url)};
const ctx={exports:{},URL,URLSearchParams,document:{documentElement:{dataset:{appHost:'unified'}}},window:{location,history:{replaceState:(_a,_b,url)=>history.push(url)},sessionStorage:{setItem:(k,v)=>storage.set(k,v)}}};
vm.runInNewContext(compile('packages/shared/src/applicationSwitch.ts'),ctx);const access=ctx.exports;
for(const role of ['admin','purchaser','deliverer']){assert.equal(access.canOpenManagement({role}),role!=='deliverer');for(const page of ['dashboard','inventory','spares','expenses','products','ledger'])assert.equal(access.canOpenManagementPage({role},page),role==='admin'||role==='purchaser'&&['inventory','spares'].includes(page))}
assert.equal(access.initialApplication('','','management'),'management');assert.equal(access.initialApplication('?itemId=x','','management'),'delivery');assert.equal(access.initialApplication('?taskKind=invoice','','delivery'),'management');assert.equal(access.initialApplication('','#bid-calculator','management'),'delivery');assert.equal(access.initialApplication('?setup=1','','management'),'delivery');
access.switchApplication('management');assert.equal(reloads,1);assert.equal(storage.get(access.applicationModeKey),'management');assert.equal(history[0],'/?v=keep');assert.equal(destinations.length,0,'Unified switch retains the delivery origin and path');
ctx.document.documentElement.dataset.appHost='';access.switchApplication('delivery');assert.equal(destinations[0],'https://test-repo-delivery.vercel.app/');
async function mount(role,kind){let hooks=[],cursor=0,pending=[],dirty=true,tree,switched=[];const session={user:{id:'fixture'},staff:{id:'fixture',code:role==='admin'?'AA':role==='purchaser'?'EE':'DD',name:'検証',role}};
const react={lazy:()=> 'BidCalculator',Suspense:'Suspense',useState(initial){const n=cursor++;hooks[n]??={value:typeof initial==='function'?initial():initial};return[hooks[n].value,v=>{hooks[n].value=typeof v==='function'?v(hooks[n].value):v;dirty=true}]},useEffect(fn,deps){const n=cursor++,old=hooks[n];if(!old||deps.some((v,i)=>v!==old.deps[i])){old?.cleanup?.();const entry=hooks[n]={deps};pending.push(()=>entry.cleanup=fn())}}};
const w={location:{hash:'',pathname:'/',search:''},addEventListener(){},removeEventListener(){},confirm:()=>false};
const mocks={exports:{},window:w,require:name=>name==='react'?react:name==='react/jsx-runtime'?{jsx,jsxs:jsx}:name==='@bussan/shared'?{...access,loadSession:async()=>session,staffDisplayName:()=>session.staff.name,switchApplication:mode=>switched.push(mode)}:name.endsWith('useCompactBidViewport')?{useCompactBidViewport:()=>false}:name.endsWith('.css')?{}:{__esModule:true,default:name.split('/').at(-1)}};
vm.runInNewContext(compile('apps/'+kind+'/src/App.tsx'),mocks);
async function settle(){for(let n=0;n<40;n++){if(dirty){cursor=0;dirty=false;tree=mocks.exports.default();pending.splice(0).forEach(fn=>fn())}await Promise.resolve()}}
await settle();
if(kind==='admin'&&role!=='deliverer'){
 const menu=all(tree).find(n=>n.type==='nav'&&n.props['aria-label']==='管理アプリのメニュー');assert(menu);
 const pages=all(menu).filter(n=>n.type==='button');assert.deepEqual(pages.map(text),role==='admin'?['ダッシュボード','在庫','予備','経費','商品リスト','古物台帳']:['在庫','予備']);
 pages.find(n=>text(n)==='在庫').props.onClick();await settle();assert(all(tree).some(n=>n.type==='Inventory'));
 const active=all(tree).filter(n=>n.type==='button'&&n.props['aria-current']==='page');assert.equal(active.length,1);assert.equal(text(active[0]),'在庫');
 all(tree).find(n=>n.type==='button'&&text(n)==='納品アプリへ').props.onClick();assert.deepEqual(switched,['delivery']);
}
if(kind==='admin'){const nav=all(tree).filter(n=>n.type==='button'&&n.props.className==='nav').map(text);if(role==='purchaser'){assert.deepEqual(nav,['在庫','予備','ログアウト']);assert(!all(tree).some(n=>n.type==='Dashboard'));assert(all(tree).some(n=>n.type==='Inventory'));}else if(role==='admin'){assert(nav.includes('ダッシュボード')&&nav.includes('経費')&&nav.includes('古物台帳'));}else{assert(!nav.length);assert(!all(tree).some(n=>n.type==='Inventory'));}}
else{let button=()=>all(tree).find(n=>n.type==='button'&&text(n)==='管理アプリへ');assert.equal(!!button(),role!=='deliverer');if(role==='purchaser'){all(tree).find(n=>n.type==='button'&&text(n)==='請求書・領収書').props.onClick();await settle();const invoice=()=>all(tree).find(n=>n.type==='Invoices');invoice().props.onNavigationChange('busy');await settle();assert(button().props.disabled);invoice().props.onNavigationChange('dirty');await settle();button().props.onClick();assert.equal(switched.length,0);w.confirm=()=>true;button().props.onClick();assert.deepEqual(switched,['management']);}}}
(async()=>{for(const role of ['admin','purchaser','deliverer']){await mount(role,'admin');await mount(role,'delivery')}console.log('App switch roles, purchaser-only inventory/spares, same URL, notification routing and unsaved invoice guard passed')})().catch(e=>{console.error(e);process.exitCode=1});
