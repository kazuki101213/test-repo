const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),{test}=require('node:test'),assert=require('node:assert/strict'),{webcrypto,createHmac}=require('node:crypto');
function load(source,extra={}) {
 const context={exports:{},crypto:webcrypto,TextEncoder,Uint8Array,atob,URL,Date,AbortSignal,Request,Response,console,...extra};
 vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,context);
 return context.exports;
}
const validation=load(fs.readFileSync(__dirname+'/validation.ts','utf8'));
function fixture({auth=true,active=true,role='deliverer',configured=true,linked=true,botStatus=200,rows=[],pushStatus=200,prepare=true,mediaFail=false,enabled=true}={}) {
 const state={rpc:[],calls:[]};let handler;
 const client={auth:{getUser:async()=>({data:{user:auth?{id:'self'}:null}})},from(table){const query={select(){return query;},eq(field,value){state.lastFilter={table,field,value};return query;},maybeSingle:async()=>({data:table==='profiles'?{staff_id:'own-staff'}:table==='staff'?{id:'own-staff',role,is_active:active}:table==='delivery_line_settings'?{enabled}:linked?{linked_at:'2026-10-24',blocked:false}:null,error:null})};return query;},rpc:async(name,args)=>{state.rpc.push({name,args});return {data:name==='delivery_push_config'?{delivery_push_dispatch_token:'private-dispatch'}:name==='claim_delivery_line'?rows:name==='prepare_delivery_line_message'?prepare:name==='handle_delivery_line_event',error:null};}};
 const source=fs.readFileSync(__dirname+'/index.ts','utf8').replace(/^import .*\n/gm,'');
 load(source,{...validation,QRCode:{},prepareShippingMedia:async({media})=>{if(mediaFail)throw Error('fixture media unavailable');return media;},createClient:()=>client,fetch:async(url,init)=>{state.calls.push({url,init});if(url.endsWith('/push')&&pushStatus===0)throw Error('network response lost');return Response.json(url.endsWith('/info')?{basicId:'@fixture',displayName:'Fixture'}:{},{status:url.endsWith('/info')?botStatus:url.endsWith('/push')?pushStatus:200});},Deno:{env:{get:name=>name==='LINE_CHANNEL_SECRET'?'fixture-secret':name==='LINE_CHANNEL_ACCESS_TOKEN'?(configured?'fixture-token':undefined):undefined},serve:fn=>handler=fn}});
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
test('Missing supplier URL omits that line but preserves exact item and three photos',()=>{
 const payload={itemId:'e6d0e28b-f6eb-46d1-998a-3581ba232401',serial:'2346b',sku:'2346b-AALL-20260927-0',supplierUrl:null,images:['front','model','code'].map(x=>'https://fixture.invalid/'+x+'.jpg')};
 const messages=validation.shippingMessages(payload);assert.equal(messages.length,4);assert(messages[0].text.includes('【2346b】'));assert(messages[0].text.includes('?itemId='+payload.itemId));assert(!messages[0].text.includes('［仕入れ先］'));assert.throws(()=>validation.shippingMessages({...payload,supplierUrl:''}));assert.throws(()=>validation.shippingMessages({...payload,supplierUrl:'https://unexpected.invalid/item'}));
});
test('Private connection check never sends messages or exposes credentials; invalid token disables registration',async()=>{
 const f=fixture();assert.equal((await f.request('connection')).status,401);assert.equal(f.state.calls.length,0);
 const result=await (await f.request('connection',{'x-delivery-dispatch':'private-dispatch'})).json();
 assert(result.verified);assert.equal(result.displayName,'Fixture');assert(!JSON.stringify(result).includes('fixture-token'));assert(f.state.calls.every(x=>x.url.endsWith('/info')));
 const invalid=fixture({botStatus:401});const status=await (await invalid.request('status')).json();assert.equal(status.configured,false);assert.equal(status.officialUrl,null);
});


test('Dispatch preserves retry key/body, handles accepted duplicate and retries network/server limits only',async()=>{
 const payload={itemId:'afc5bc0f-677e-4c03-b8ff-5aa806ef129b',serial:'2392',sku:'2392-EEMM-20261002-591',supplierUrl:'https://auctions.yahoo.co.jp/jp/auction/c1236938625',images:['front','model'].map(x=>'https://fixture.invalid/'+x+'.jpg'),withoutBarcode:'size_unset'};
 const row={id:'e7ec5622-fef2-4d58-a7a9-9b53e10c2799',lease:'fixture-lease',eligible:true,recipient:'fixture-recipient',payload};
 for(const [status,state]of[[200,'sent'],[409,'sent'],[429,'pending'],[503,'pending'],[400,'failed'],[0,'pending']]){
  const f=fixture({rows:[row],pushStatus:status});const result=await f.request('dispatch',{'x-delivery-dispatch':'private-dispatch'});assert.equal(result.status,200);
  const push=f.state.calls.find(x=>x.url.endsWith('/push'));assert(push);assert.equal(push.init.headers['X-Line-Retry-Key'],row.id);assert.equal(JSON.parse(push.init.body).messages.length,3);
  assert.equal(f.state.rpc.findLast(x=>x.name==='finish_delivery_line').args.p_state,state);
  const before=push.init.body;await f.request('dispatch',{'x-delivery-dispatch':'private-dispatch'});assert.equal(f.state.calls.filter(x=>x.url.endsWith('/push')).at(-1).init.body,before);
 }
});
test('Dispatch stops after trade/assignee recheck, media failure or disabled setting without LINE push',async()=>{
 const row={id:'fixture',lease:'fixture',eligible:true,recipient:'fixture',payload:{media:{}}};
 for(const options of[{rows:[{...row,eligible:false}]},{rows:[row],prepare:false},{rows:[row],mediaFail:true},{rows:[row],enabled:false}]){
  const f=fixture(options);assert.equal((await f.request('dispatch',{'x-delivery-dispatch':'private-dispatch'})).status,200);assert(!f.state.calls.some(x=>x.url.endsWith('/push')));
 }
});

test('Explicit initial notice sends text once with a distinct stable key; follow-up keeps images',async()=>{
 const payload={itemId:'afc5bc0f-677e-4c03-b8ff-5aa806ef129b',serial:'2303b',sku:'2303b-EEII-20260927-0',title:'BDZ-FBW1000',supplierUrl:null,images:[],initialNotice:true,deliveryRetryKey:'e7ec5622-fef2-4d58-a7a9-9b53e10c2799'};
 const row={id:'afc5bc0f-677e-4c03-b8ff-5aa806ef129b',lease:'lease',eligible:true,recipient:'fixture',payload};
 const f=fixture({rows:[row]});await f.request('dispatch',{'x-delivery-dispatch':'private-dispatch'});
 const push=f.state.calls.find(x=>x.url.endsWith('/push'));assert(push);assert.equal(push.init.headers['X-Line-Retry-Key'],payload.deliveryRetryKey);
 const messages=JSON.parse(push.init.body).messages;assert.equal(messages.length,1);assert(messages[0].text.includes('BDZ-FBW1000'));assert(messages[0].text.includes('準備でき次第'));assert(messages[0].text.includes('?itemId='+payload.itemId));
 await f.request('dispatch',{'x-delivery-dispatch':'private-dispatch'});assert.equal(f.state.calls.filter(x=>x.url.endsWith('/push')).at(-1).init.body,push.init.body);
 assert.throws(()=>validation.shippingMessages({...payload,initialNotice:false}));
 const followup=validation.shippingMessages({...payload,initialNotice:false,imageFollowup:true,images:['front','model','code'].map(x=>'https://fixture.invalid/'+x+'.png')});
 assert.equal(followup.length,4);assert(followup[0].text.startsWith('発送用の写真・コードです。'));assert(!followup[0].text.includes('発送お願いします。'));
 const cancelled=fixture({rows:[row],prepare:false});await cancelled.request('dispatch',{'x-delivery-dispatch':'private-dispatch'});assert(!cancelled.state.calls.some(x=>x.url.endsWith('/push')));
});

test('Listing photo recovery is not available through a user or public request',async()=>{
 const f=fixture();assert.equal((await f.request('recover-listing-photo-files')).status,401);assert(!f.state.calls.some(x=>x.url.endsWith('/push')));
});
