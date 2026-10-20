const fs=require('fs'),vm=require('vm'),ts=require('typescript'),assert=require('node:assert/strict');
const compile=f=>ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const jsx=(type,props)=>({type,props});
const all=n=>!n||typeof n!=='object'?[]:Array.isArray(n)?n.flatMap(all):[n,...all(n.props?.children)];
function runtime(){let cursor=0;const hooks=[];return{reset(){cursor=0;},react:{useState(v){const n=cursor++;hooks[n]??={value:typeof v==='function'?v():v};return[hooks[n].value,v=>hooks[n].value=typeof v==='function'?v(hooks[n].value):v];},useRef(v){return hooks[cursor++]??={current:v};},useEffect(){}}};}
async function dateDialog(){
 const rt=runtime();const c={exports:{},Intl,Date,require:n=>n==='react'?rt.react:n==='react/jsx-runtime'?{jsx,jsxs:jsx}:{default:'component'}};vm.runInNewContext(compile('apps/delivery/src/components/WorkDateConfirmation.tsx'),c);
 let writes=0,closed=0,release;const props={title:'作業完了しますか。',purchasedAt:'2026-01-01',onCancel:()=>closed++,onConfirm:async date=>{writes++;assert.equal(date,'2026-02-03');await new Promise(r=>release=r);}};
 const render=()=>{rt.reset();return c.exports.default(props);};let tree=render();const field=()=>all(tree).find(n=>n.props?.['aria-label']==='作業完了日');
 assert.equal(tree.props.title,props.title);tree.props.onCancel();assert.equal(writes,0);assert.equal(closed,1);
 field().props.onChange({target:{value:'2026-02-30'}});tree=render();assert(tree.props.confirmDisabled,'Impossible date disabled');
 field().props.onChange({target:{value:'2099-01-01'}});tree=render();assert(tree.props.confirmDisabled,'Future date disabled');
 field().props.onChange({target:{value:'2025-12-31'}});tree=render();assert(tree.props.confirmDisabled,'Pre-purchase date disabled');
 field().props.onChange({target:{value:'2026-02-03'}});tree=render();assert(!tree.props.confirmDisabled);tree.props.onConfirm();tree.props.onConfirm();assert.equal(writes,1);tree=render();assert(tree.props.busy);release();for(let i=0;i<10;i++)await Promise.resolve();assert.equal(closed,2);
 props.savedDate='2026-02-03';tree=render();assert(field().props.disabled,'Existing dates cannot be overwritten from completion');
}
async function controls(){
 const shared={exports:{}};vm.runInNewContext(compile('packages/shared/src/workflow.ts'),shared);
 const base={id:'fixture',sku:'2503-test',purchased_at:'2026-01-01',status:'動作不良',supplier_contact_requested_at:'now',marketplace:'ヤフオク'};
 for(const status of ['動作不良','Amazon補填申請中']){
  const buttons=Array.from(shared.exports.deliveryWorkflowButtons({...base,status}));assert.deepEqual(buttons.map(b=>b.label),status==='動作不良'?['仕入担当者へメッセージ','取引メッセージ','返品完了','返品不可','作業完了','動作不良取消']:['補填完了','作業完了']);assert(!shared.exports.deliveryWorkflowButtons({...base,status,packed_on:'2026-02-03'}).some(b=>b.key==='work_complete'));
 }
 for(const action of ['supplier_return_complete','work_complete','compensation_complete']){
  const rt=runtime();let calls=[];const api={performDatedInventoryAction:async(...args)=>calls.push(['dated',...args]),completeDeliveryWork:async(...args)=>calls.push(['work',...args]),completeDeliveryCompensation:async(...args)=>calls.push(['compensation',...args])};const c={exports:{},crypto:require('crypto').webcrypto,require:n=>n==='react'?rt.react:n==='react/jsx-runtime'?{jsx,jsxs:jsx}:n==='@bussan/shared'?shared.exports:n==='../api'?api:{default:'component'}};
  vm.runInNewContext(compile('apps/delivery/src/components/WorkflowControls.tsx'),c);
  const props={task:{...base,status:action==='compensation_complete'?'Amazon補填申請中':'動作不良'},onChanged:async()=>{},onError:()=>{}};
  const render=()=>{rt.reset();return c.exports.default(props);};let tree=render();all(tree).find(n=>n.props?.['data-action']===action).props.onClick();tree=render();assert.equal(calls.length,0);const modal=all(tree).find(n=>n.props?.onConfirm);assert(modal);modal.props.onCancel();assert.equal(calls.length,0);
  all(tree).find(n=>n.props?.['data-action']===action).props.onClick();tree=render();const next=all(tree).find(n=>n.props?.onConfirm);await next.props.onConfirm('2026-02-03');assert.equal(calls.length,1);assert.equal(calls[0][0],action==='work_complete'?'work':action==='compensation_complete'?'compensation':'dated');
 }
}
(async()=>{await dateDialog();await controls();console.log('PASS work date dialogs: minimal labels, date validation, cancel, duplicate save protection, immutable date, exact button order and correct RPC routing');})().catch(e=>{console.error(e);process.exitCode=1;});
