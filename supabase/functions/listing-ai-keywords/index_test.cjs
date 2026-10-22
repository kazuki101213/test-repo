const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),{test}=require('node:test'),assert=require('node:assert/strict'),{webcrypto}=require('node:crypto');
const itemId='00000000-0000-0000-0000-000000000001';
function setup({assigned=true,active=true,key=true,cached=false,status=200,words=['Aprica','抱っこひも','ベビーキャリア'],auth=true,claimState='claim'}={}){
 const state={calls:[],rpc:[],updates:[],profiles:[{staff_id:'staff'}],staff:[{role:'deliverer',is_active:active}],items:[{id:itemId,deliverer_id:assigned?'staff':'other',products:{model_no:'ラクリス'},sales_channel:'メルカリ'}]};
 const client={auth:{getUser:async()=>({data:{user:auth?{id:'user'}:null},error:null})},rpc:async(name,args)=>{state.rpc.push(args);return{data:cached?{cached:true,keywords:'キャッシュ語',previous:[]}:{[claimState]:true,claim:claimState==='claim'?'token':undefined,previous:[]},error:null};},from(table){const query={select(){return query;},eq(){return query;},update(value){state.updates.push(value);return query;},maybeSingle:async()=>({data:state[table]?.[0]??null,error:null}),then:(a,b)=>Promise.resolve({data:[{item_id:itemId}],error:null}).then(a,b)};return query;}};
 let source=fs.readFileSync(__dirname+'/index.ts','utf8').replace(/import \{ createClient \}[^\n]+\n/,'').replace('if(import.meta.main)Deno.serve(handler);','');
 const context={exports:{},createClient:()=>client,crypto:webcrypto,TextEncoder,Uint8Array,AbortSignal,Response,Request,fetch:async(url,init)=>{state.calls.push({url,init});return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({keywords:words})}]}}]},{status});},Deno:{env:{get:name=>name==='GEMINI_API_KEY'?(key?'test-key':undefined):name==='GEMINI_KEYWORDS_MODEL'?undefined:'test-setting'}}};
 vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,context);
 async function request(override={},authorization=true){return context.exports.handler(new Request('https://fixture.invalid',{method:'POST',headers:authorization?{authorization:'Bearer test'}:{},body:JSON.stringify({itemId,target:'mercari',title:'【2500】Aprica ラクリス',category:'小物',manufacturer:'Aprica',...override})}));}
 return {state,request};
}
test('Only assigned active authenticated staff can request Gemini',async()=>{
 for(const opts of [{assigned:false},{active:false},{auth:false}]){const {request,state}=setup(opts);assert([401,403].includes((await request()).status));assert.equal(state.calls.length,0);}
 const {request,state}=setup();assert.equal((await request({},false)).status,401);assert.equal((await request({target:'amazon'})).status,400);assert.equal(state.calls.length,0);
});
test('Gemini uses public product data only and structured keywords are cached',async()=>{
 const {request,state}=setup();const response=await request({description:'buyer private text',sku:'private-sku',buyer:'private-name'});assert.equal(response.status,200);assert.equal((await response.json()).keywords,'Aprica 抱っこひも ベビーキャリア');
 assert.equal(state.calls.length,1);const payload=JSON.stringify(JSON.parse(state.calls[0].init.body));assert(!payload.includes('private-'));assert(!payload.includes('2500'));assert(payload.includes('ラクリス'));assert.equal(state.calls[0].init.headers['x-goog-api-key'],'test-key');assert.equal(state.updates.at(-1).state,'ready');
});
test('Cache, missing key and concurrent/quota claims cannot call Gemini',async()=>{
 for(const opts of [{cached:true},{key:false},{claimState:'wait'},{claimState:'limited'}]){const {request,state}=setup(opts);const res=await request();assert.equal(state.calls.length,0);assert.equal(res.status,opts.cached?200:opts.key===false?503:429);}
});
test('Quota/invalid Gemini response does not save text and releases claim',async()=>{
 for(const opts of [{status:429},{status:502},{words:[]},{words:['<script>bad</script>']},{words:['line\nline']}]){const {request,state}=setup(opts);assert([429,502].includes((await request()).status));assert.equal(state.updates.at(-1).state,'failed');assert(!state.updates.some(row=>row.state==='ready'));}
});
