const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),{test}=require('node:test'),assert=require('node:assert/strict'),{webcrypto,createHmac}=require('node:crypto');
function load(source,extra={}) {
 const context={exports:{},crypto:webcrypto,TextEncoder,Uint8Array,atob,URL,Date,AbortSignal,Request,Response,console,...extra};
 vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,context);
 return context.exports;
}
const validation=load(fs.readFileSync(__dirname+'/validation.ts','utf8'));
function fixture({auth=true,active=true,role='deliverer',configured=true,linked=true,botStatus=200}={}) {
 const state={rpc:[],calls:[]};let handler;
 const client={auth:{getUser:async()=>({data:{user:auth?{id:'self'}:null}})},from(table){const query={select(){return query;},eq(field,value){state.lastFilter={table,field,value};return query;},maybeSingle:async()=>({data:table==='profiles'?{staff_id:'own-staff'}:table==='staff'?{id:'own-staff',role,is_active:active}:linked?{linked_at:'2026-10-24',blocked:false}:null,error:null})};return query;},rpc:async(name,args)=>{state.rpc.push({name,args});return {data:name==='delivery_push_config'?{delivery_push_dispatch_token:'private-dispatch'}:name==='handle_delivery_line_event',error:null};}};
 const source=fs.readFileSync(__dirname+'/index.ts','utf8').replace(/^import .*\n/gm,'');
 load(source,{...validation,createClient:()=>client,fetch:async(url,init)=>{state.calls.push({url,init});return Response.json(url.endsWith('/info')?{basicId:'@fixture',displayName:'Fixture'}:{},{status:url.endsWith('/info')?botStatus:200});},Deno:{env:{get:name=>name==='LINE_CHANNEL_SECRET'?'fixture-secret':name==='LINE_CHANNEL_ACCESS_TOKEN'?(configured?'fixture-token':undefined):undefined},serve:fn=>handler=fn}});
 const request=(action,headers={})=>handler(new Request('https://fixture.invalid/delivery-line',{method:'POST',headers:{Origin:validation.deliveryOrigin,Authorization:'Bearer fixture',...headers},body:JSON.stringify({action,staffId:'someone-else'})}));
 async function webhook(events,{sign=true,change=false}={}){let body=JSON.stringify({events});const signature=createHmac('sha256','fixture-secret').update(body).digest('base64');if(change)body+=' ';return handler(new Request('https://fixture.invalid/delivery-line/webhook',{method:'POST',headers:sign?{'x-line-signature':signature}:{},body}));}
 return{state,request,webhook};
}
test('LINE HMAC verifies exact bytes and rejects missing/tampered signatures',async()=>{
 const raw='{"events":[]}';const signature=createHmac('sha256','secret').update(raw).digest('base64');
 assert(await validation.validSignature(raw,signature,'secret'));assert(!await validation.validSignature(raw+' ',signature,'secret'));assert(!await validation.validSignature(raw,null,'secret'));assert(!await validation.validSignature(raw,'invalid','secret'));
 for(const options of [{sign:false},{change:true}]){const f=fixture();assert.equal((await f.webhook([],options)).status,401);assert.equal(f.state.rpc.length,0);}
});
test('Only active authenticated delivery staff can issue, inspect or unlink their own binding',async()=>{
 for(const opts of [{auth:false},{active:false},{role:'purchaser'}])for(const action of ['status','issue','unlink']){const f=fixture(opts);assert([401,403].includes((await f.request(action)).status));assert.equal(f.state.rpc.length,0);}
 const f=fixture();assert.equal((await f.request('issue',{Origin:'https://evil.invalid'})).status,403);
 const issued=await (await f.request('issue')).json();assert(/^連携 [a-f0-9]{32}$/.test(issued.message));assert.equal(f.state.rpc[0].args.p_staff,'own-staff');assert.notEqual(f.state.rpc[0].args.p_hash,issued.message.slice(3));assert.equal(f.state.rpc[0].args.p_hash.length,64);
 const status=await (await f.request('status')).json();assert(status.linked);assert(status.configured);assert.equal(status.officialUrl,'https://line.me/R/ti/p/%40fixture');assert(!('line_user_id' in status));
 await f.request('unlink');assert.equal(f.state.rpc.at(-1).args.p_staff,'own-staff');
 assert.equal((await fixture({configured:false}).request('issue')).status,503);
});
test('Only signed one-to-one link text is consumed; group messages never bind staff',async()=>{
 const base={webhookEventId:'fixture-event',timestamp:Date.now(),type:'message',replyToken:'fixture-reply',source:{type:'user',userId:'U'+'a'.repeat(32)},message:{type:'text',text:'連携 '+'b'.repeat(32)}};
 const f=fixture();assert.equal((await f.webhook([{...base,source:{...base.source,type:'group'}}])).status,200);assert.equal(f.state.rpc.length,0);
 await f.webhook([{...base,timestamp:Date.now()-90000000}]);assert.equal(f.state.rpc.length,0);
 await f.webhook([base]);assert.equal(f.state.rpc[0].args.p_hash,await validation.hashCode('b'.repeat(32)));assert.equal(f.state.calls.length,1);assert(f.state.calls[0].url.endsWith('/reply'));
 await f.webhook([{...base,type:'unfollow'}]);assert.equal(f.state.rpc.at(-1).args.p_kind,'unfollow');
});
test('Shipping bundles exact requested text and three images; incomplete media cannot send',()=>{
 const p={itemId:'afc5bc0f-677e-4c03-b8ff-5aa806ef129b',serial:'2392',sku:'2392-EEMM-20261002-591',supplierUrl:'https://auctions.yahoo.co.jp/jp/auction/c1236938625',images:['whole','model','code'].map(x=>'https://fixture.invalid/'+x+'.png')};
 const messages=validation.shippingMessages(p);assert.equal(messages.length,4);assert.equal(messages[0].text,`発送お願いします。\n【2392】\n${p.sku}\n［仕入れ先］${p.supplierUrl}\n［納品アプリ］${validation.deliveryOrigin}/?itemId=${p.itemId}`);
 assert(messages.slice(1).every(x=>x.type==='image'));assert.throws(()=>validation.shippingMessages({...p,images:[]}));assert.throws(()=>validation.shippingMessages({...p,supplierUrl:'javascript:alert(1)'}));assert.throws(()=>validation.shippingMessages({...p,images:['http://a','https://b','https://c']}));
 assert.equal(validation.dispatchState(409),'sent');assert.equal(validation.dispatchState(500),'pending');assert.equal(validation.dispatchState(400),'failed');
});
test('Private connection check never sends messages or exposes credentials; invalid token disables registration',async()=>{
 const f=fixture();assert.equal((await f.request('connection')).status,401);assert.equal(f.state.calls.length,0);
 const result=await (await f.request('connection',{'x-delivery-dispatch':'private-dispatch'})).json();
 assert(result.verified);assert.equal(result.displayName,'Fixture');assert(!JSON.stringify(result).includes('fixture-token'));assert(f.state.calls.every(x=>x.url.endsWith('/info')));
 const invalid=fixture({botStatus:401});const status=await (await invalid.request('status')).json();assert.equal(status.configured,false);assert.equal(status.officialUrl,null);
});
