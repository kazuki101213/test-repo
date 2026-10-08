const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),assert=require('node:assert/strict'),path=require('node:path');
const root=path.resolve(process.argv[2]||'.');
const compile=f=>ts.transpileModule(fs.readFileSync(path.join(root,f),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const errors={exports:{},Error};vm.runInNewContext(compile('apps/delivery/src/errors.ts'),errors);
assert.equal(errors.exports.deliveryErrorMessage({message:'担当を確認してください',details:'取得に失敗',hint:'再読み込み'}),'担当を確認してください / 取得に失敗 / 再読み込み');
assert.equal(errors.exports.deliveryErrorMessage(new Error('通信エラー')),'通信エラー');
assert(!errors.exports.deliveryErrorMessage({}).includes('[object Object]'));
let cursor=0,hooks=[],effects=[],dirty=true,tree,failed=true;const listeners={};
const react={useState(v){const n=cursor++;if(!hooks[n])hooks[n]={value:typeof v==='function'?v():v};return[hooks[n].value,next=>{hooks[n].value=typeof next==='function'?next(hooks[n].value):next;dirty=true;}];},useRef(v){return hooks[cursor++]??={current:v};},useCallback(fn){cursor++;return fn;},useMemo(fn){cursor++;return fn();},useEffect(fn,deps){const n=cursor++;if(!hooks[n]||deps.some((v,i)=>v!==hooks[n].deps[i])){hooks[n]={deps};effects.push(fn);}}};
const jsx=(type,props)=>({type,props});
const row={id:'mm-item',sku:'2392-AAMM-20261002-591',lot_seq:2392,status:'作業中',shipped_on:null,deliverer_id:'MM',marketplace:'ヤフオク'};
const api={fetchMyTasks:async()=>{if(failed)throw{message:'この商品はあなたの担当ではありません',code:'42501'};return[row];},fetchDeliveryItemNotices:async()=>[]};
const context={exports:{},require:id=>id==='react'?react:id==='react/jsx-runtime'?{jsx,jsxs:jsx}:id==='../errors'?errors.exports:id==='../api'?api:id==='@bussan/shared'?{canViewDeliveryAssignee:()=>false,staffDisplayName:x=>x}:id==='../deliverySearch'?{deliverySearchFields:[],normalizeSearch:x=>x.trim(),deliverySearchValue:()=>''}:id==='../hooks/useTaskViewport'?{useTaskViewport:()=>({sectionRef:{},shippingRef:{},viewportHeight:400})}:{default:id},URLSearchParams,Set,Map,window:{location:{search:''},setInterval(){},clearInterval(){},addEventListener(name,fn){listeners[name]=fn;},removeEventListener(){}},document:{visibilityState:'visible',addEventListener(){},removeEventListener(){}}};
vm.runInNewContext(compile('apps/delivery/src/pages/TaskList.tsx'),context);
const props={staff:{id:'MM',code:'MM',role:'deliverer',name:'株式会社吉光'}};
async function settle(){for(let i=0;i<35;i++){if(dirty){cursor=0;dirty=false;tree=context.exports.default(props);effects.splice(0).forEach(fn=>fn());}await Promise.resolve();}}
function text(n){return n==null?'':Array.isArray(n)?n.map(text).join(''):typeof n==='object'?text(n.props?.children):String(n);}
function nodes(n,out=[]){if(!n||typeof n!=='object')return out;if(Array.isArray(n)){n.forEach(v=>nodes(v,out));return out;}out.push(n);nodes(n.props?.children,out);return out;}
(async()=>{await settle();assert(text(tree).includes('この商品はあなたの担当ではありません'));assert(!text(tree).includes('[object Object]'));failed=false;listeners.focus();await settle();assert(!text(tree).includes('この商品はあなたの担当ではありません'));assert(nodes(tree).some(n=>n.props?.task?.id==='mm-item'));console.log('Actual MM TaskList shows database message and recovers to assigned inventory on refresh');})().catch(e=>{console.error(e);process.exitCode=1;});
