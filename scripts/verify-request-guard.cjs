// 同じ読み込みの連発だけを遅らせ、普段の読み込み・書き込み・認証は遅らせないことを確かめる。
const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),assert=require('node:assert/strict');
const compile=f=>ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const warnings=[];
const ctx={exports:{},URL,DOMException,Request,Response,setTimeout,clearTimeout,console:{warn:(...a)=>warnings.push(a.join(' '))}};
vm.runInNewContext(compile('packages/shared/src/requestGuard.ts'),ctx);
const {guardedReadKey,readGuardDelay,resetReadGuard,createGuardedFetch,READ_GUARD_LIMIT,READ_GUARD_PAUSE_MS,READ_GUARD_WINDOW_MS}=ctx.exports;
const base='https://x.supabase.co';

// 対象：GET/HEADと read_/list_ のRPC。書き込み・認証・ストレージは対象外。
assert.ok(guardedReadKey(`${base}/rest/v1/v_delivery_tasks?id=eq.1`,{method:'GET'}));
assert.ok(guardedReadKey(`${base}/rest/v1/photo_reviews?item_id=eq.1`));
assert.ok(guardedReadKey(`${base}/rest/v1/rpc/read_inventory_page`,{method:'POST',body:'{}'}));
assert.equal(guardedReadKey(`${base}/rest/v1/rpc/save_delivery_description`,{method:'POST',body:'{}'}),null);
assert.equal(guardedReadKey(`${base}/rest/v1/items?id=eq.1`,{method:'PATCH'}),null);
assert.equal(guardedReadKey(`${base}/auth/v1/user`),null);
assert.equal(guardedReadKey(`${base}/storage/v1/object/sign/item-photos`,{method:'POST'}),null);
assert.notEqual(guardedReadKey(`${base}/rest/v1/rpc/read_inventory_page`,{method:'POST',body:'{"a":1}'}),guardedReadKey(`${base}/rest/v1/rpc/read_inventory_page`,{method:'POST',body:'{"a":2}'}));

// 1分に上限回までは待たない。超えた分だけ待つ。違う読み込みは別に数える。
resetReadGuard();
let now=1_000_000;
for(let i=0;i<READ_GUARD_LIMIT;i++)assert.equal(readGuardDelay('k',now+i*100),0,'普段の回数では待たない');
assert.equal(readGuardDelay('k',now+READ_GUARD_LIMIT*100),READ_GUARD_PAUSE_MS,'上限を超えたら間を空ける');
assert.equal(readGuardDelay('other',now+READ_GUARD_LIMIT*100),0,'別の読み込みは影響を受けない');
assert.equal(readGuardDelay('k',now+READ_GUARD_LIMIT*100+READ_GUARD_PAUSE_MS),READ_GUARD_PAUSE_MS,'連発が続く間は間を空け続ける');
assert.equal(readGuardDelay('k',now+READ_GUARD_WINDOW_MS*3),0,'1分以上止めば元に戻る');

// 5秒ごと（一覧の自動更新の最短）や15秒ごと（監視）では一度も待たない。
resetReadGuard();
for(let i=0;i<200;i++)assert.equal(readGuardDelay('list',i*5000),0);
for(let i=0;i<200;i++)assert.equal(readGuardDelay('watch',i*15000),0);

// 1秒ごとの連発（今回の不具合）は、上限後は10秒おきに抑えられる。
resetReadGuard();
let t=0,sent=0;
while(t<5*60_000){t+=1000+readGuardDelay('loop',t);sent++;}
assert.ok(sent<=READ_GUARD_LIMIT+30,`5分で${sent}回に抑えられる（対策前は300回）`);

(async()=>{
  resetReadGuard();
  let clock=0;const calls=[];
  const guarded=createGuardedFetch(async(input)=>{calls.push(String(input));return new Response('[]');},()=>clock);
  for(let i=0;i<READ_GUARD_LIMIT;i++)await guarded(`${base}/rest/v1/photo_reviews?item_id=eq.1`);
  assert.equal(calls.length,READ_GUARD_LIMIT);
  // 書き込みは何回でも待たない。
  for(let i=0;i<50;i++)await guarded(`${base}/rest/v1/rpc/save_delivery_description`,{method:'POST',body:'{}'});
  assert.equal(calls.length,READ_GUARD_LIMIT+50);
  // 上限を超えた読み込みは中止できる。
  const controller=new AbortController();
  const pending=guarded(`${base}/rest/v1/photo_reviews?item_id=eq.1`,{signal:controller.signal});
  controller.abort();
  await assert.rejects(pending);
  assert.equal(calls.length,READ_GUARD_LIMIT+50,'中止した読み込みは送らない');
  assert.equal(warnings.length,1,'警告は1回だけ');
  console.log('verify-request-guard: ok');
})().catch(error=>{console.error(error);process.exit(1);});
