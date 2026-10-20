const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),assert=require('node:assert/strict');
const compile=file=>ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const shared={exports:{}};vm.runInNewContext(compile('packages/shared/src/workflow.ts'),shared);
const base={id:'one',sku:'2407-AAII-test',marketplace:'ヤフオク',sales_channel:'メルカリ',photo_review_approved:true};
const cases=[['検品中','return_request_cancel',{marketplace:'Amazon返品'}],['商品登録前','inspection_cancel'],['商品登録前','yahoo_instruction_cancel',{workflow_decision:'yahoo'}],['出品中','listing_cancel'],['取引中','trade_cancel'],['取引中','resell'],['動作不良','report_cancel'],['返品処理','supplier_return_cancel'],['検品中','report'],['Amazon返送依頼','return_request_complete'],['検品中','inspection_complete'],['動作不良','return_impossible',{supplier_contact_requested_at:'now'}]];
function all(n){return !n||typeof n!=='object'?[]:Array.isArray(n)?n.flatMap(all):[n,...all(n.props?.children)];}
async function check(status,key,extra={},failure=false){
 let cursor=0,hooks=[],tree,calls=[],changes=0,release,messages=[];
 const react={useState(v){const n=cursor++;hooks[n]??={value:v};return[hooks[n].value,next=>{hooks[n].value=typeof next==='function'?next(hooks[n].value):next;}];},useRef(v){return hooks[cursor++]??={current:v};},useEffect(){}};
 const jsx=(type,props)=>({type,props});
 const context={exports:{},crypto:require('node:crypto').webcrypto,window:{confirm(){throw Error('Native OK confirmation is forbidden for reversal');}},require:id=>id==='react'?react:id==='react/jsx-runtime'?{jsx,jsxs:jsx}:id==='@bussan/shared'?shared.exports:id==='./WorkflowConfirmation'?{default:(props)=>{const c={exports:{},require:name=>name==='react'?react:name==='react/jsx-runtime'?{jsx,jsxs:jsx}:{}};vm.runInNewContext(compile('apps/delivery/src/components/WorkflowConfirmation.tsx'),c);return c.exports.default(props);}}:{performInventoryAction:async(...args)=>{calls.push(args);await new Promise((resolve,reject)=>{release=()=>failure?reject({message:'実行中の操作の結果を確認してから状態を変更してください'}):resolve();});}}};
 vm.runInNewContext(compile('apps/delivery/src/components/WorkflowControls.tsx'),context);
 const props={task:{...base,status,...extra},onChanged:async()=>{changes++;},onError:error=>{if(error){messages.push(error);if(!failure)throw Error(error);}}};
 function render(){cursor=0;tree=context.exports.default(props);}
 function dialog(){return all(tree).find(n=>typeof n.type==='function');}
 function choose(){all(tree).find(n=>n.props?.['data-action']===key).props.onClick();render();if(key==='report'){all(tree).find(n=>n.type==='textarea').props.onChange({target:{value:'動作不良の実際の報告内容'}});render();all(tree).find(n=>n.type==='button'&&n.props.children==='仕入担当者に報告').props.onClick();render();}}
 render();choose();assert.equal(calls.length,0);assert(dialog());
 const popup=dialog().type(dialog().props);assert.equal(popup.type,'dialog');assert(all(popup).some(n=>n.props?.children==='実行しますか'));assert(all(popup).some(n=>n.props?.children==='はい'));assert(all(popup).some(n=>n.props?.children==='キャンセル'));
 let prevented=false;popup.props.onCancel({preventDefault(){prevented=true;}});assert(prevented);render();assert(!dialog());assert.equal(calls.length,0);
 choose();const yes=dialog().props.onConfirm;yes();yes();assert.equal(calls.length,1);assert.equal(calls[0][1],key);if(key==='report')assert.equal(calls[0][2],'動作不良の実際の報告内容','Confirmation must retain the typed report');
 if(['listing_cancel','trade_cancel','resell'].includes(key))assert(calls[0][2].trim());
 release();for(let i=0;i<10;i++)await Promise.resolve();render();assert.equal(changes,failure?0:1);assert(!dialog());if(failure)assert.equal(messages.at(-1),'実行中の操作の結果を確認してから状態を変更してください');
}
(async()=>{await check('商品登録前','inspection_cancel',{},true);for(const entry of cases)await check(...entry);console.log('PASS: all reversal and direct forward actions ask Yes/Cancel, cancel sends nothing, yes executes once with required note');})().catch(error=>{console.error(error);process.exitCode=1;});
