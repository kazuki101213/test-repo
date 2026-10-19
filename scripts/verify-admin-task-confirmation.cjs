const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),assert=require('node:assert/strict');
const compile=(file,extra='')=>ts.transpileModule(fs.readFileSync(file,'utf8')+extra,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const jsx=(type,props)=>({type,props});
const all=n=>!n||typeof n!=='object'?[]:Array.isArray(n)?n.flatMap(all):[n,...all(n.props?.children)];
function runtime(){let cursor=0,hooks=[];const react={useState(initial){const n=cursor++;hooks[n]??={value:initial};return[hooks[n].value,v=>{hooks[n].value=typeof v==='function'?v(hooks[n].value):v;}];},useRef(v){return hooks[cursor++]??={current:v};},useEffect(){}};return{react,reset(){cursor=0;}};}
const rt=runtime(),context={exports:{},require:id=>id==='react'?rt.react:id==='react-dom'?{createPortal:n=>n}:{jsx,jsxs:jsx},document:{body:{}}};
vm.runInNewContext(compile('apps/admin/src/components/TaskConfirmation.tsx'),context);
const render=()=>{rt.reset();return context.exports.useTaskConfirmation();};
(async()=>{
 let writes=0,release;let hook=render();hook.ask('完了',async()=>{writes++;});hook.ask('second',async()=>{writes+=10;});hook=render();assert.equal(hook.confirmation.props.request.label,'完了','Repeated asks cannot replace an open request');
 hook.confirmation.props.onClose();assert.equal(writes,0);assert.equal(render().confirmation,null);
 hook=render();hook.ask('送信',async()=>{writes++;await new Promise(r=>release=r);});hook=render();
 const props=hook.confirmation.props;
 const modalRuntime=runtime();const modalContext={exports:{},require:id=>id==='react'?modalRuntime.react:id==='react-dom'?{createPortal:n=>n}:{jsx,jsxs:jsx},document:{body:{}}};
 vm.runInNewContext(compile('apps/admin/src/components/TaskConfirmation.tsx','\nexport { Confirmation };'),modalContext);
 let closed=0;const request={label:'送信',action:props.request.action};
 const modal=()=>{modalRuntime.reset();return modalContext.exports.Confirmation({request,onClose:()=>closed++});};
 let tree=modal();assert(all(tree).some(n=>n.props?.children==='実行しますか'));
 let prevented=false;tree.props.onCancel({preventDefault(){prevented=true;}});assert(prevented);assert.equal(closed,1);assert.equal(writes,0);
 tree=modal();all(tree).find(n=>n.props?.children==='キャンセル').props.onClick();assert.equal(closed,2);assert.equal(writes,0);
 const yes=all(tree).find(n=>n.props?.children==='はい').props.onClick;yes();yes();assert.equal(writes,1);
 tree=modal();tree.props.onCancel({preventDefault(){}});assert.equal(closed,2,'Escape cannot dismiss an executing operation');assert(all(tree).filter(n=>n.type==='button').every(n=>n.props.disabled));
 release();for(let n=0;n<12;n++)await Promise.resolve();assert.equal(closed,3);
 request.action=async()=>{throw Error('failed');};tree=modal();all(tree).find(n=>n.props?.children==='はい').props.onClick();for(let n=0;n<12;n++)await Promise.resolve();tree=modal();assert(all(tree).some(n=>n.props?.role==='alert'));assert.equal(closed,3,'Failed operation remains available for retry');
 const inventory={exports:{}};vm.runInNewContext(compile('apps/admin/src/inventory.ts'),inventory);
 const template={exports:{},require:id=>id==='../inventory'?inventory.exports:{}};vm.runInNewContext(compile('apps/admin/src/components/MalfunctionTasks.tsx','\nexport { templateBody };'),template);
 const item={lot_seq:1856,sku:'1856b-EEMM-20261019-1000',marketplace_item_id:'m1234567891',products:[{model_no:'BDZ-ZW550'}]};
 const prefix='【1856b】【m1234567891】【BDZ-ZW550】\n';
 assert.equal(template.exports.templateBody('仕入先確認',item),prefix+'取引メッセージより仕入先へ連絡お願いします。');
 const makers=['Panasonic◯','Panasonic×','SONY◯','SONY×','SHARP◯','SHARP×','TOSHIBA◯','TOSHIBA×'];
 const bodies=makers.map(m=>template.exports.templateBody(m+'ヤフオク',item));assert(bodies.every(b=>b===bodies[0]&&b.startsWith(prefix)));assert(bodies[0].includes('リモコンやB-CASカードや電源ケーブルは予備としてください。'));
 const other=template.exports.templateBody('ヤフオク その他',item);assert(other.startsWith(prefix));assert(other.includes('付属品はすべてつけてください。'));assert(!other.includes('予備としてください'));
 console.log('PASS: cancel/Escape write nothing, confirmation executes once, busy/error handling; all 10 templates use the actual suffixed serial, item ID and model');
})().catch(e=>{console.error(e);process.exitCode=1;});

async function spareDeleteConfirmation() {
 let hooks=[],cursor=0,effects=[],dirty=true,tree,deletes=0,release;
 const react={useState(initial){const n=cursor++;hooks[n]??={value:typeof initial==='function'?initial():initial};return[hooks[n].value,next=>{hooks[n].value=typeof next==='function'?next(hooks[n].value):next;dirty=true;}];},useRef:v=>hooks[cursor++]??={current:v},useCallback(fn,deps){const n=cursor++;if(!hooks[n]||deps.some((v,i)=>v!==hooks[n].deps[i]))hooks[n]={deps,fn};return hooks[n].fn;},useEffect(fn,deps){const n=cursor++;if(!hooks[n]||deps.some((v,i)=>v!==hooks[n].deps[i])){hooks[n]={deps};effects.push(fn);}}};
 const confirm={exports:{},require:id=>id==='react'?react:id==='react-dom'?{createPortal:n=>n}:{jsx,jsxs:jsx},document:{body:{}}};vm.runInNewContext(compile('apps/admin/src/components/TaskConfirmation.tsx'),confirm);
 const shared={staffDisplayName:()=>'',deliveryStaffOptions:x=>x,MARKETPLACES:[],spareSearchFields:[],matchesSpareSearch:()=>true,yen:v=>String(v),fetchSpareAccessories:async()=>[{id:'spare-1',title:'確認用リモコン',source_sku:'2508-test'}],deleteSpareAccessory:async id=>{assert.equal(id,'spare-1');deletes++;await new Promise(r=>release=r);}};
 const ctx={exports:{},require:id=>id==='react'?react:id==='react/jsx-runtime'?{jsx,jsxs:jsx}:id==='@bussan/shared'?shared:id==='../components/TaskConfirmation'?confirm.exports:id==='../api'?{fetchStaff:async()=>[]}: {default:'input'},window:{setInterval(){},clearInterval(){},addEventListener(){},removeEventListener(){}},document:{visibilityState:'visible',addEventListener(){},removeEventListener(){}}};
 vm.runInNewContext(compile('apps/admin/src/pages/Spares.tsx'),ctx);
 async function settle(){for(let n=0;n<20;n++){if(dirty){cursor=0;dirty=false;tree=ctx.exports.default({me:{id:'AA',role:'admin'}});effects.splice(0).forEach(fn=>fn());}await Promise.resolve();}}
 const modal=()=>all(tree).find(n=>n.props?.request?.label?.startsWith('予備の削除'));
 await settle();const remove=()=>all(tree).find(n=>n.props?.className==='btn danger spare-row-delete');remove().props.onClick();await settle();assert(modal());assert.equal(deletes,0);assert(modal().props.request.label.includes('2508-test'));assert(modal().props.request.notice.includes('取り消せません'));
 modal().props.onClose();await settle();assert(!modal());assert.equal(deletes,0);remove().props.onClick();await settle();assert(remove().props.disabled);const action=modal().props.request.action;const pending=action();assert.equal(deletes,1);release();await pending;await settle();assert(!remove(),'Only the selected spare disappears after successful deletion');
 console.log('PASS: spare deletion opens confirmation, cancel does not delete, approved action targets its own row');
}
spareDeleteConfirmation().catch(e=>{console.error(e);process.exitCode=1;});
