const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),assert=require('node:assert/strict');
const compile=file=>ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const jsx=(type,props)=>({type,props});
function all(n){return !n||typeof n!=='object'?[]:Array.isArray(n)?n.flatMap(all):[n,...all(n.props?.children)];}
function text(n){return n==null?'':Array.isArray(n)?n.map(text).join(''):typeof n==='object'?text(n.props?.children):String(n);}
const errors={exports:{},Error};vm.runInNewContext(compile('apps/delivery/src/errors.ts'),errors);
async function check(failure,refreshFailure){
 let cursor=0,hooks=[],effects=[],dirty=true,tree,release,requests=[],contexts=0;
 const react={useState(initial){const n=cursor++;hooks[n]??={value:typeof initial==='function'?initial():initial};return[hooks[n].value,v=>{hooks[n].value=typeof v==='function'?v(hooks[n].value):v;dirty=true;}];},useRef(v){return hooks[cursor++]??={current:v};},useEffect(fn,deps){const n=cursor++;if(!hooks[n]){hooks[n]={deps};effects.push(fn);}}};
 const client={rpc:async(name,args)=>{
  if(name==='line_shipping_context'){contexts++;return contexts>1&&refreshFailure?{data:null,error:{message:'状態取得の通信エラー'}}:{data:{state:contexts>1?'pending':'sent',shipping:{},message:'',enabled:true},error:null};}
  requests.push({name,args});await new Promise(r=>release=r);
  return failure?{data:null,error:{message:'全体写真と型番写真を先に保存してください'}}:{data:{queued:true,codeRequired:true},error:null};
 }};
 const context={exports:{},Error,require:id=>id==='react'?react:id==='react/jsx-runtime'?{jsx,jsxs:jsx}:id==='@bussan/shared'?{getSupabase:()=>client}:id==='../errors'?errors.exports:{}};
 vm.runInNewContext(compile('apps/delivery/src/components/LineShippingSettings.tsx'),context);
 async function settle(){for(let i=0;i<25;i++){if(dirty){cursor=0;dirty=false;tree=context.exports.default({itemId:'same-item',draft:{size:'100'}});effects.splice(0).forEach(fn=>fn());}await Promise.resolve();}}
 await settle();
 const button=all(tree).find(n=>n.type==='button'&&text(n)==='LINEを再送');assert(button);
 button.props.onClick();button.props.onClick();await settle();assert.equal(requests.length,1,'Double click must queue once');
 assert.equal(requests[0].name,'request_delivery_line_resend');assert.equal(requests[0].args.p_item_id,'same-item');
 release();await settle();
 if(failure){assert(text(tree).includes('全体写真と型番写真を先に保存してください'),'Supabase object errors must retain the actionable reason');assert(!text(tree).includes('LINE再送を受け付けられませんでした'));}
 else{assert(text(tree).includes('配送コードを含むLINE再送を受け付けました'));assert(!all(tree).some(n=>n.type==='button'&&text(n)==='LINEを再送'),'Queued request must not invite a second resend');}
 if(refreshFailure){assert(text(tree).includes('再送は受け付けました。表示の更新に失敗しました。状態取得の通信エラー'));assert.equal(requests.length,1);}
}
(async()=>{await check(true,false);await check(false,false);await check(false,true);console.log('PASS LINE resend: actionable RPC errors, double-click lock, accepted request survives refresh failure');})().catch(error=>{console.error(error);process.exitCode=1;});
