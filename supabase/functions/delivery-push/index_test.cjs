const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),{test}=require('node:test'),assert=require('node:assert/strict');
function fixture({rows=[],token='fixture-token'}={}){
 const calls=[];let handler;
 const source=fs.readFileSync(__dirname+'/index.ts','utf8').replace(/^import .*\r?\n/gm,'');
 const client={rpc:async(name,args)=>{calls.push({name,args});return {data:name==='delivery_push_config'?{delivery_push_dispatch_token:'fixture-token',delivery_push_vapid:'{}'}:name==='claim_admin_push'?rows:name==='claim_delivery_push'?[]:null,error:null};}};
 const context={exports:{},Request,Response,URL,console,Deno:{env:{get:()=>''},serve:fn=>handler=fn},createClient:()=>client,ApplicationServer:{new:async()=>({})},importVapidKeys:async()=>({}),appBaseUrls:{admin:['https://fixture.invalid'],delivery:['https://delivery.invalid']}};
 vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,context);
 return {calls,run:()=>handler(new Request('https://fixture.invalid',{method:'POST',headers:{'x-delivery-dispatch':token},body:JSON.stringify({action:'dispatch'})}))};
}
test('empty dispatch never starts another HTTP batch',async()=>{const f=fixture();assert.equal((await f.run()).status,200);assert(!f.calls.some(c=>c.name==='kick_delivery_push'));});
test('full batch finishes its claims and wakes remaining work once',async()=>{const f=fixture({rows:Array.from({length:20},(_,i)=>({delivery_id:String(i),eligible:false}))});assert.equal((await f.run()).status,200);assert.equal(f.calls.filter(c=>c.name==='finish_admin_push').length,20);assert.equal(f.calls.filter(c=>c.name==='kick_delivery_push').length,1);});
test('partial batch does not create perpetual dispatch and unauthorized requests never claim',async()=>{const f=fixture({rows:[{delivery_id:'one',eligible:false}]});assert.equal((await f.run()).status,200);assert(!f.calls.some(c=>c.name==='kick_delivery_push'));const denied=fixture({token:'wrong'});assert.equal((await denied.run()).status,401);assert(!denied.calls.some(c=>c.name.startsWith('claim_')));});
