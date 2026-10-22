const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),assert=require('node:assert/strict');
const compile=file=>ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const all=n=>!n||typeof n!=='object'?[]:Array.isArray(n)?n.flatMap(all):[n,...all(n.props?.children)];
const jsx=(type,props)=>({type,props});
async function apiTest(){
 let uploads=[],reports=[],fail=false;
 const sb={functions:{invoke:async(name,{body})=>{assert.equal(name,'malfunction-report-photos');uploads.push({id:body.get('photoId'),order:body.get('sortOrder'),request:body.get('requestId')});return fail&&uploads.length===2?{error:{message:'Drive failure'}}:{data:{id:body.get('photoId')},error:null};}},rpc:async(name,args)=>{assert(['submit_malfunction_report','report_item_with_damage'].includes(name));reports.push(args);return{error:null};}};
 const context={exports:{},require:()=>({getSupabase:()=>sb}),File,Blob,FormData,createImageBitmap:async()=>({width:1,height:1,close(){}}),document:{createElement:()=>({getContext:()=>({fillRect(){},drawImage(){}}),toBlob:fn=>fn(new Blob([new Uint8Array([255,216,255])],{type:'image/jpeg'}))})}};
 vm.runInNewContext(compile('apps/delivery/src/api.ts'),context);
 const photos=[{id:'p1',file:new File(['1'],'front.png',{type:'image/png'})},{id:'p2',file:new File(['2'],'back.png',{type:'image/png'})}];
 await context.exports.submitMalfunctionReport({id:'item',status:'検品中'},'報告本文','request',photos);
 assert.equal(uploads.length,2);assert.equal(reports.length,1);assert.deepEqual(Array.from(reports[0].p_photo_ids),['p1','p2']);assert.deepEqual(uploads.map(p=>p.order),['0','1']);assert(uploads.every(p=>p.request==='request'));
 uploads=[];reports=[];await context.exports.submitMalfunctionReport({id:'item',status:'検品中'},'録画不可。','damage-request',[],true);assert.equal(reports[0].p_has_physical_damage,true);assert.equal(reports[0].p_note,'録画不可。\nはそんがあります。');assert.equal(uploads.length,0);
 uploads=[];reports=[];fail=true;await assert.rejects(context.exports.submitMalfunctionReport({id:'item',status:'検品中'},'報告本文','request',photos),/Drive failure/);assert.equal(reports.length,0,'Partial upload cannot submit the report');
}
async function workflowTest(){
 let cursor=0,hooks=[],tree,sends=0,changed=0,error=null,fail=true;
 const react={useState(initial){const n=cursor++;hooks[n]??={value:initial};return[hooks[n].value,next=>{hooks[n].value=typeof next==='function'?next(hooks[n].value):next;}];},useRef:initial=>hooks[cursor++]??={current:initial}};
 const shared={exports:{}};vm.runInNewContext(compile('packages/shared/src/workflow.ts'),shared);
 const ctx={exports:{},crypto:require('node:crypto').webcrypto,require:id=>id==='react'?react:id==='react/jsx-runtime'?{jsx,jsxs:jsx}:id==='@bussan/shared'?shared.exports:id==='./WorkflowConfirmation'?{default:'confirm'}:{performInventoryAction:async()=>{throw Error('Photos must use the atomic report API');},submitMalfunctionReport:async(task,note,request,photos,damage)=>{sends++;assert.equal(note,'写真付き報告');assert.equal(photos.length,1);assert.equal(damage,true);if(fail)throw Error('Drive failure');}}};
 vm.runInNewContext(compile('apps/delivery/src/components/WorkflowControls.tsx'),ctx);
 const render=()=>{cursor=0;tree=ctx.exports.default({task:{id:'item',sku:'1-test',status:'検品中',marketplace:'メルカリ'},onChanged:async()=>{changed++;},onError:e=>error=e});};
 render();all(tree).find(n=>n.props?.['data-action']==='report').props.onClick();render();all(tree).find(n=>n.type==='textarea').props.onChange({target:{value:'写真付き報告'}});render();
 all(tree).find(n=>n.type==='input'&&n.props.type==='checkbox').props.onChange({target:{checked:true}});render();
 all(tree).find(n=>n.props?.['aria-label']==='報告写真を選択').props.onChange({target:{files:[{name:'front.jpg',type:'image/jpeg'}],value:'selected'}});render();
 const actions=all(tree).find(n=>n.props?.className==='workflow-report-actions');const buttons=all(actions).filter(n=>n.type==='button');assert.equal(buttons[0].props['aria-label'],'写真を追加（1枚）');assert.equal(buttons[1].props.children,'仕入担当者に報告');
 buttons[1].props.onClick();render();all(tree).find(n=>n.type==='confirm').props.onCancel();render();assert.equal(sends,0);
 all(tree).find(n=>n.type==='button'&&n.props.children==='仕入担当者に報告').props.onClick();render();await all(tree).find(n=>n.type==='confirm').props.onConfirm();for(let n=0;n<8;n++)await Promise.resolve();render();assert.match(error,/Drive failure/);assert.equal(changed,0);assert(all(tree).some(n=>n.props?.['aria-label']==='写真を追加（1枚）'),'Failure keeps the selected attachment');
 fail=false;all(tree).find(n=>n.type==='button'&&n.props.children==='仕入担当者に報告').props.onClick();render();const confirm=all(tree).find(n=>n.type==='confirm').props.onConfirm;confirm();confirm();for(let n=0;n<12;n++)await Promise.resolve();render();assert.equal(sends,2);assert.equal(changed,1);assert(!all(tree).some(n=>n.type==='textarea'));
}
async function managerTest(){
 let cursor=0,hooks=[],tree,reads=0,resolveRead;
 const react={useState(initial){const n=cursor++;hooks[n]??={value:initial};return[hooks[n].value,next=>{hooks[n].value=typeof next==='function'?next(hooks[n].value):next;}];},useRef:initial=>hooks[cursor++]??={current:initial}};
 const sb={rpc:async(name,args)=>{assert.equal(name,'read_malfunction_report_photos');assert.equal(args.p_item_id,'item');reads++;return new Promise(resolve=>{resolveRead=resolve;});}};
 const context={exports:{},require:id=>id==='react'?react:id==='react/jsx-runtime'?{jsx,jsxs:jsx}:{getSupabase:()=>sb}};
 vm.runInNewContext(compile('apps/admin/src/components/MalfunctionReportPhotos.tsx'),context);
 const render=()=>{cursor=0;tree=context.exports.default({itemId:'item'});};render();assert.equal(reads,0,'Rendering must not read photos');
 const click=all(tree).find(n=>n.type==='button').props.onClick;click();click();assert.equal(reads,1,'A rapid double click cannot duplicate the request');
 resolveRead({data:[{id:'photo',drive_file_id:'private_file_123',sort_order:0}],error:null});for(let n=0;n<12;n++)await Promise.resolve();render();
 const link=all(tree).find(n=>n.type==='a');assert.equal(link.props.href,'https://drive.google.com/file/d/private_file_123/view');assert.equal(link.props.rel,'noopener noreferrer');
 all(tree).find(n=>n.type==='button').props.onClick();render();assert(!all(tree).some(n=>n.type==='a'));all(tree).find(n=>n.type==='button').props.onClick();render();assert.equal(reads,1,'Reopening uses the loaded metadata');assert(all(tree).some(n=>n.type==='a'));
}
(async()=>{await apiTest();await workflowTest();await managerTest();console.log('PASS: ordered Drive uploads before atomic report; cancel/failure/retry/double-submit; manager lazy reads and cached private links');})().catch(error=>{console.error(error);process.exitCode=1;});
