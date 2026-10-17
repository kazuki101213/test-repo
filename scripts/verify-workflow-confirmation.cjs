const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),assert=require('node:assert/strict');
const compile=file=>ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const shared={exports:{}};vm.runInNewContext(compile('packages/shared/src/workflow.ts'),shared);
const base={id:'one',sku:'2407-AAII-test',marketplace:'ヤフオク',sales_channel:'メルカリ',photo_review_approved:true};
const cases=[['検品中','return_request_cancel',{marketplace:'Amazon返品'}],['商品登録前','inspection_cancel'],['商品登録前','yahoo_instruction_cancel',{workflow_decision:'yahoo'}],['出品中','listing_cancel'],['取引中','trade_cancel'],['取引中','resell'],['動作不良','report_cancel'],['返品処理','supplier_return_cancel']];
function all(n){return !n||typeof n!=='object'?[]:Array.isArray(n)?n.flatMap(all):[n,...all(n.props?.children)];}
async function check(status,key,extra={}){
 let cursor=0,hooks=[],tree,calls=[],changes=0,release;
 const react={useState(v){const n=cursor++;hooks[n]??={value:v};return[hooks[n].value,next=>{hooks[n].value=typeof next==='function'?next(hooks[n].value):next;}];},useRef(v){return hooks[cursor++]??={current:v};},useEffect(){}};
 const jsx=(type,props)=>({type,props});
 const context={exports:{},crypto:require('node:crypto').webcrypto,window:{confirm(){throw Error('Native OK confirmation is forbidden for reversal');}},require:id=>id==='react'?react:id==='react/jsx-runtime'?{jsx,jsxs:jsx}:id==='@bussan/shared'?shared.exports:{performInventoryAction:async(...args)=>{calls.push(args);await new Promise(resolve=>{release=resolve;});}}};
 vm.runInNewContext(compile('apps/delivery/src/components/WorkflowControls.tsx'),context);
 const props={task:{...base,status,...extra},onChanged:async()=>{changes++;},onError:error=>{if(error)throw Error(error);}};
 function render(){cursor=0;tree=context.exports.default(props);}
 function dialog(){return all(tree).find(n=>typeof n.type==='function');}
 function choose(){all(tree).find(n=>n.props?.['data-action']===key).props.onClick();render();}
 render();choose();assert.equal(calls.length,0);assert(dialog());
 const popup=dialog().type(dialog().props);assert.equal(popup.type,'dialog');assert(all(popup).some(n=>n.props?.children==='実行しますか'));assert(all(popup).some(n=>n.props?.children==='はい'));assert(all(popup).some(n=>n.props?.children==='キャンセル'));
 dialog().props.onCancel();render();assert(!dialog());assert.equal(calls.length,0);
 choose();const yes=dialog().props.onConfirm;yes();yes();assert.equal(calls.length,1);assert.equal(calls[0][1],key);
 if(['listing_cancel','trade_cancel','resell'].includes(key))assert(calls[0][2].trim());
 release();for(let i=0;i<10;i++)await Promise.resolve();render();assert.equal(changes,1);assert(!dialog());
}
(async()=>{for(const entry of cases)await check(...entry);console.log('PASS: all eight reversal actions ask Yes/Cancel, cancel sends nothing, yes executes once with required note');})().catch(error=>{console.error(error);process.exitCode=1;});
