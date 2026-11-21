const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),{test}=require('node:test'),assert=require('node:assert/strict');
const itemId='00000000-0000-0000-0000-000000000001';
function setup({allowed=true,key=true,status=200,message='お世話になっております。\n届いた商品の電源が入りませんでした。返品と返金をお願いできますでしょうか。',auth=true,report='電源が入らない。',messages=[{author_role:'other',body:'ご購入ありがとうございます'}],finish='STOP'}={}){
 const state={calls:[]};
 const item={title:'【2500】【m123】SONY リモコン RMT-B015J',marketplace:'メルカリ',malfunction_comment:report,products:{model_no:'RMT-B015J',maker:'SONY'}};
 const client={auth:{getUser:async()=>({data:{user:auth?{id:'user'}:null},error:null})},
  rpc:async()=>allowed?{data:{account_id:'mercari-1',messages},error:null}:{data:null,error:{message:'権限がありません'}},
  from(){const query={select(){return query;},eq(){return query;},maybeSingle:async()=>({data:item,error:null})};return query;}};
 const source=fs.readFileSync(__dirname+'/index.ts','utf8').replace(/import \{ createClient \}[^\n]+\n/,'').replace('if(import.meta.main)Deno.serve(handler);','');
 const context={exports:{},createClient:()=>client,AbortSignal,Response,Request,
  fetch:async(url,init)=>{state.calls.push({url,init});return Response.json({candidates:[{finishReason:finish,content:{parts:[{text:JSON.stringify({message})}]}}]},{status});},
  Deno:{env:{get:name=>name==='GEMINI_API_KEY'?(key?'test-key':undefined):name.startsWith('GEMINI_')?undefined:'test-setting'}}};
 vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,context);
 const request=(body={itemId},authorization=true)=>context.exports.handler(new Request('https://fixture.invalid',{method:'POST',headers:authorization?{authorization:'Bearer test'}:{},body:JSON.stringify(body)}));
 return {state,request};
}
test('Only staff who can read the conversation can draft',async()=>{
 for(const opts of [{allowed:false},{auth:false}]){const {request,state}=setup(opts);assert([401,403].includes((await request()).status));assert.equal(state.calls.length,0);}
 const {request,state}=setup();assert.equal((await request({itemId},false)).status,401);assert.equal((await request({itemId:'bad'})).status,400);assert.equal(state.calls.length,0);
});
test('Draft uses the malfunction report and conversation, without SKU or management numbers',async()=>{
 const {request,state}=setup();const response=await request();assert.equal(response.status,200);
 assert.match((await response.json()).message,/返品と返金/);
 const payload=JSON.parse(state.calls[0].init.body).contents[0].parts[0].text;
 assert(payload.includes('電源が入らない'));assert(payload.includes('ご購入ありがとうございます'));assert(payload.includes('RMT-B015J'));
 assert(!payload.includes('2500'));assert(!payload.includes('m123'));assert.equal(state.calls[0].init.headers['x-goog-api-key'],'test-key');
});
test('No report and no messages, or missing key, does not call Gemini',async()=>{
 for(const [opts,code] of [[{report:'',messages:[]},400],[{key:false},503]]){const {request,state}=setup(opts);assert.equal((await request()).status,code);assert.equal(state.calls.length,0);}
});
test('Quota or invalid Gemini output returns an error instead of a draft',async()=>{
 for(const opts of [{status:429},{status:500},{message:''},{message:'<script>x</script>'},{finish:'MAX_TOKENS'}]){const {request}=setup(opts);const res=await request();assert([429,502].includes(res.status));assert.equal((await res.json()).message,undefined);}
});
