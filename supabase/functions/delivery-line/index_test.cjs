const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),{test}=require('node:test'),assert=require('node:assert/strict'),{webcrypto,createHmac}=require('node:crypto');
function load(source,extra={}) {
 const context={exports:{},crypto:webcrypto,TextEncoder,Uint8Array,atob,URL,Date,AbortSignal,Request,Response,console,...extra};
 vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,context);
 return context.exports;
}
const validation=load(fs.readFileSync(__dirname+'/validation.ts','utf8'));
function fixture({auth=true,active=true,role='deliverer',configured=true,linked=true,botStatus=200,rows=[],pushStatus=200,prepare=true,mediaFail=false,enabled=true,photoSelectionFail=false,invoiceRows=[],invoiceRecipients={}}={}) {
 const state={rpc:[],calls:[]};let handler;
 const client={auth:{getUser:async()=>({data:{user:auth?{id:'self'}:null}})},from(table){const query={select(){return query;},eq(field,value){state.lastFilter={table,field,value};return query;},maybeSingle:async()=>({data:table==='profiles'?{staff_id:'own-staff'}:table==='staff'?{id:'own-staff',role,is_active:active}:table==='delivery_line_settings'?{enabled}:linked?{linked_at:'2026-10-24',blocked:false}:null,error:null})};return query;},rpc:async(name,args)=>{state.rpc.push({name,args});return {data:name==='delivery_push_config'?{delivery_push_dispatch_token:'private-dispatch'}:name==='claim_delivery_line'?rows:name==='prepare_delivery_line_message'?prepare:name==='handle_delivery_line_event',error:null};}};
 const shippingRpc=client.rpc;
 client.rpc=async(name,args)=>{
  if(name==='claim_invoice_approval_line'||name==='invoice_approval_line_recipient'||name==='finish_invoice_approval_line'){
   state.rpc.push({name,args});
   return {data:name==='claim_invoice_approval_line'?invoiceRows:name==='invoice_approval_line_recipient'?invoiceRecipients[args.p_invoice]:null,error:null};
  }
  return shippingRpc(name,args);
 };
 const source=fs.readFileSync(__dirname+'/index.ts','utf8').replace(/^import [^\r\n]*(?:\r?\n|$)/gm,'');
 load(source,{...validation,QRCode:{},selectLinePhotos:async()=>{state.photoSelectionCalls=(state.photoSelectionCalls||0)+1;if(photoSelectionFail)throw Error('temporary AI failure');return{processed:0};},prepareShippingMedia:async({media})=>{if(mediaFail)throw Error('fixture media unavailable');return media;},createClient:()=>client,fetch:async(url,init)=>{state.calls.push({url,init});if(url.endsWith('/push')&&pushStatus===0)throw Error('network response lost');return Response.json(url.endsWith('/info')?{basicId:'@fixture',displayName:'Fixture'}:{},{status:url.endsWith('/info')?botStatus:url.endsWith('/push')?pushStatus:200});},Deno:{env:{get:name=>name==='LINE_CHANNEL_SECRET'?'fixture-secret':name==='LINE_CHANNEL_ACCESS_TOKEN'?(configured?'fixture-token':undefined):undefined},serve:fn=>handler=fn}});
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

test('Yahoo Fleamarket purchase links survive dispatch with the original item and retry key',async()=>{
 const payload={itemId:'f076528b-da2d-44e2-8a61-c49002e3bff6',serial:'2118a',sku:'2118a-AAII-18991230-1200',supplierUrl:'https://paypayfleamarket.yahoo.co.jp/item/z657512394',images:['front','model','code'].map(x=>'https://fixture.invalid/'+x+'.png')};
 const retryKey='a0cb5c8e-e286-4919-9081-2e571260ac11';
 const row={id:'10b4980a-22db-4b59-9b30-49ab2e431282',lease:'fixture-lease',eligible:true,recipient:'fixture-recipient',payload:{...payload,lineRetryKey:retryKey}};
 const f=fixture({rows:[row]});await f.request('dispatch',{'x-delivery-dispatch':'private-dispatch'});
 const push=f.state.calls.find(x=>x.url.endsWith('/push'));assert(push,'Yahoo Fleamarket purchase must not stop before LINE push');
 const sent=JSON.parse(push.init.body);assert.equal(sent.messages.length,4);assert(sent.messages[0].text.includes('［仕入れ先］'+payload.supplierUrl));assert.equal(push.init.headers['X-Line-Retry-Key'],retryKey);
 assert.equal(f.state.rpc.findLast(x=>x.name==='finish_delivery_line').args.p_state,'sent');
 for(const supplierUrl of ['https://paypayfleamarket.yahoo.co.jp.evil.invalid/item/z657512394','http://paypayfleamarket.yahoo.co.jp/item/z657512394'])assert.throws(()=>validation.shippingMessages({...payload,supplierUrl}));
});
test('Private connection check never sends messages or exposes credentials; invalid token disables registration',async()=>{
 const f=fixture();assert.equal((await f.request('connection')).status,401);assert.equal(f.state.calls.length,0);
 const result=await (await f.request('connection',{'x-delivery-dispatch':'private-dispatch'})).json();
 assert(result.verified);assert.equal(result.displayName,'Fixture');assert(!JSON.stringify(result).includes('fixture-token'));assert(f.state.calls.every(x=>x.url.endsWith('/info')));
 const invalid=fixture({botStatus:401});const status=await (await invalid.request('status')).json();assert.equal(status.configured,false);assert.equal(status.officialUrl,null);
});


test('Dispatch preserves retry key/body, handles accepted duplicate and retries network/server limits only',async()=>{
 const payload={itemId:'afc5bc0f-677e-4c03-b8ff-5aa806ef129b',serial:'2392',sku:'2392-EEMM-20261002-591',supplierUrl:'https://auctions.yahoo.co.jp/jp/auction/c1236938625',images:['front','model'].map(x=>'https://fixture.invalid/'+x+'.jpg'),withoutBarcode:'size_unset'};
 const retryKey='c8b8391d-b7b2-4de8-a62e-e910410bf7b9';
 const row={id:'e7ec5622-fef2-4d58-a7a9-9b53e10c2799',lease:'fixture-lease',eligible:true,recipient:'fixture-recipient',payload:{...payload,lineRetryKey:retryKey}};
 for(const [status,state]of[[200,'sent'],[409,'sent'],[429,'pending'],[503,'pending'],[400,'failed'],[0,'pending']]){
  const f=fixture({rows:[row],pushStatus:status});const result=await f.request('dispatch',{'x-delivery-dispatch':'private-dispatch'});assert.equal(result.status,200);
  const push=f.state.calls.find(x=>x.url.endsWith('/push'));assert(push);assert.equal(push.init.headers['X-Line-Retry-Key'],retryKey);assert.equal(JSON.parse(push.init.body).messages.length,3);
  assert.equal(f.state.rpc.findLast(x=>x.name==='finish_delivery_line').args.p_state,state);
  const before=push.init.body;await f.request('dispatch',{'x-delivery-dispatch':'private-dispatch'});const repeated=f.state.calls.filter(x=>x.url.endsWith('/push')).at(-1);assert.equal(repeated.init.body,before);assert.equal(repeated.init.headers['X-Line-Retry-Key'],retryKey);
 }
});
test('Dispatch stops after trade/assignee recheck, media failure or disabled setting without LINE push',async()=>{
 const row={id:'fixture',lease:'fixture',eligible:true,recipient:'fixture',payload:{media:{}}};
 for(const options of[{rows:[{...row,eligible:false}]},{rows:[row],prepare:false},{rows:[row],mediaFail:true},{rows:[row],enabled:false}]){
  const f=fixture(options);assert.equal((await f.request('dispatch',{'x-delivery-dispatch':'private-dispatch'})).status,200);assert(!f.state.calls.some(x=>x.url.endsWith('/push')));
 }
});
test('A missing stored retry key never produces a misleading sent result',async()=>{
 const payload={itemId:'afc5bc0f-677e-4c03-b8ff-5aa806ef129b',serial:'2392',sku:'2392-EEMM-20261002-591',supplierUrl:null,images:['front','model','code'].map(x=>'https://fixture.invalid/'+x+'.jpg')};
 const row={id:'e7ec5622-fef2-4d58-a7a9-9b53e10c2799',lease:'fixture-lease',eligible:true,recipient:'fixture-recipient',payload};
 const f=fixture({rows:[row]});await f.request('dispatch',{'x-delivery-dispatch':'private-dispatch'});
 assert(!f.state.calls.some(x=>x.url.endsWith('/push')));
 assert.equal(f.state.rpc.findLast(x=>x.name==='finish_delivery_line').args.p_state,'failed');
});

test('Listing photo recovery is not available through a user or public request',async()=>{
 const f=fixture();assert.equal((await f.request('recover-listing-photo-files')).status,401);assert(!f.state.calls.some(x=>x.url.endsWith('/push')));
});

test('Photo auto selection is private, cannot send by itself, and its failure never stops dispatch',async()=>{
 const denied=fixture();assert.equal((await denied.request('select-line-photos')).status,401);assert(!denied.state.photoSelectionCalls);
 const allowed=fixture();assert.equal((await allowed.request('select-line-photos',{'x-delivery-dispatch':'private-dispatch'})).status,200);assert.equal(allowed.state.photoSelectionCalls,1);assert(!allowed.state.calls.some(x=>x.url.endsWith('/push')));
 const payload={automatic:true,itemId:'afc5bc0f-677e-4c03-b8ff-5aa806ef129b',serial:'2392',sku:'2392-EEMM-20261002-591',supplierUrl:null,images:[]};
 const f=fixture({photoSelectionFail:true,rows:[{id:'fixture',lease:'fixture',eligible:true,recipient:'fixture',payload:{...payload,lineRetryKey:'2768b1fd-64d5-4c3c-a9b7-9a9ad6a20d9c'}}]});
 assert.equal((await f.request('dispatch',{'x-delivery-dispatch':'private-dispatch'})).status,200);assert(f.state.calls.some(x=>x.url.endsWith('/push')));
});

test('Automatic media failure still sends one exact-item request using the same retry key',async()=>{
 const media={automatic:true,itemId:'afc5bc0f-677e-4c03-b8ff-5aa806ef129b',serial:'2392',sku:'2392-EEMM-20261002-591',supplierUrl:null,photoPaths:[],codeOperationId:null};
 const retryKey='2768b1fd-64d5-4c3c-a9b7-9a9ad6a20d9c';
 const row={id:'e7ec5622-fef2-4d58-a7a9-9b53e10c2799',lease:'fixture-lease',eligible:true,recipient:'fixture-recipient',payload:{media,lineRetryKey:retryKey}};
 const f=fixture({rows:[row],mediaFail:true});await f.request('dispatch',{'x-delivery-dispatch':'private-dispatch'});
 const push=f.state.calls.find(x=>x.url.endsWith('/push'));assert(push);const body=JSON.parse(push.init.body);assert.equal(body.messages.length,1);assert.equal(body.to,'fixture-recipient');assert(body.messages[0].text.includes('?itemId='+media.itemId));assert.equal(push.init.headers['X-Line-Retry-Key'],retryKey);assert.equal(f.state.rpc.findLast(x=>x.name==='finish_delivery_line').args.p_state,'sent');
 const stopped=fixture({rows:[row],mediaFail:true,prepare:false});await stopped.request('dispatch',{'x-delivery-dispatch':'private-dispatch'});assert(!stopped.state.calls.some(x=>x.url.endsWith('/push')),'Trade/assignee recheck is still mandatory');
});

test('Invoice dispatch sends each approved amount and protected link only to its verified recipient',async()=>{
 const a={invoice_id:'872a63bb-6095-43af-98be-7fb1a0623ac4',lease:'lease-a',retry_key:'63004842-ad1d-4d5c-8c57-6556d9ba98ae',staff_name:'担当者A',billing_month:'2026-10',total:21970};
 const b={invoice_id:'d55a612b-c7cd-4b4e-8c34-e7f1d17fa730',lease:'lease-b',retry_key:'ed0298e4-47a2-4206-82cc-7f6c48be1d86',staff_name:'担当者B',billing_month:'2026-10',total:18838};
 const recipients={[a.invoice_id]:'U'+'a'.repeat(32),[b.invoice_id]:'U'+'b'.repeat(32)};
 const auth={'x-delivery-dispatch':'private-dispatch'};
 const f=fixture({invoiceRows:[a,b],invoiceRecipients:recipients,enabled:false,pushStatus:409});
 assert.equal((await f.request('dispatch-invoice-approvals')).status,401);
 assert.equal(f.state.calls.length,0);
 const result=await (await f.request('dispatch-invoice-approvals',auth)).json();
 assert.deepEqual(result,{processed:2,sent:2});
 assert.equal(f.state.calls.length,2);
 for(const [index,row] of [a,b].entries()){
  const request=f.state.calls[index].init;
  const body=JSON.parse(request.body);
  assert.equal(body.to,recipients[row.invoice_id]);
  assert.equal(body.messages.length,1);
  const text=body.messages[0].text;
  assert(text.startsWith(row.staff_name));
  assert(text.includes('承認金額 ¥'+row.total.toLocaleString('ja-JP')));
  const link=new URL(text.split('［請求書を確認］')[1]);
  assert.equal(link.origin,validation.deliveryOrigin);
  assert.equal(link.searchParams.get('invoiceId'),row.invoice_id);
  assert.equal(link.searchParams.get('invoiceMonth'),row.billing_month);
  assert.equal(request.headers['X-Line-Retry-Key'],row.retry_key);
 }
 assert(f.state.rpc.filter(call=>call.name==='finish_invoice_approval_line').every(call=>call.args.p_state==='sent'));
 const missing=fixture({invoiceRows:[a],invoiceRecipients:{}});
 await missing.request('dispatch-invoice-approvals',auth);
 assert.equal(missing.state.calls.length,0);
 assert.equal(missing.state.rpc.at(-1).args.p_state,'pending');
 const timeout=fixture({invoiceRows:[a],invoiceRecipients:recipients,pushStatus:0});
 await timeout.request('dispatch-invoice-approvals',auth);
 await timeout.request('dispatch-invoice-approvals',auth);
 assert.equal(timeout.state.calls[0].init.body,timeout.state.calls[1].init.body);
 assert.equal(timeout.state.calls[0].init.headers['X-Line-Retry-Key'],timeout.state.calls[1].init.headers['X-Line-Retry-Key']);
 assert.equal(timeout.state.rpc.at(-1).args.p_state,'pending');
});
