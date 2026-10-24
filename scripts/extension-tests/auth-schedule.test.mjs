import test from 'node:test';import assert from 'node:assert/strict';
import {ensureAlarms} from '../../tools/fleamarket-extension/alarm-schedule.js';
const now=Date.parse('2026-10-08T00:59:40+09:00');
test('cold worker restarts do not postpone existing pulse/update alarms',async()=>{const alarms=new Map(),writes=[];const api={get:async k=>alarms.get(k),create:async(k,v)=>{writes.push(k);alarms.set(k,{...v,scheduledTime:v.when});}};await ensureAlarms(api,{trackingHour:1,receiptHour:2},{now});const pulse=alarms.get('fm:pulse').scheduledTime,update=alarms.get('fm:update').scheduledTime;for(let i=1;i<8;i++)await ensureAlarms(api,{trackingHour:1,receiptHour:2},{now:now+i*1000});assert.equal(alarms.get('fm:pulse').scheduledTime,pulse);assert.equal(alarms.get('fm:update').scheduledTime,update);assert.equal(writes.length,5);});
test('daily alarm is renewed after firing and missing pulse is restored',async()=>{const alarms=new Map(),api={get:async k=>alarms.get(k),create:async(k,v)=>alarms.set(k,{...v,scheduledTime:v.when})};await ensureAlarms(api,{trackingHour:1,receiptHour:2},{now});alarms.delete('fm:pulse');await ensureAlarms(api,{trackingHour:1,receiptHour:2},{now:now+20000,fired:'fm:tracking'});assert.equal(alarms.get('fm:tracking').scheduledTime,Date.parse('2026-10-09T01:00:00+09:00'));assert.ok(alarms.has('fm:pulse'));});
const data={},calls=[];globalThis.chrome={storage:{local:{get:async keys=>Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(k=>[k,data[k]])),set:async o=>Object.assign(data,o),remove:async keys=>{for(const k of keys)delete data[k];}}}};
const {rpc,connectSession}=await import('../../tools/fleamarket-extension/api.js');
test('invalid refresh stops repeated auth requests and verified reconnect restores RPC',async()=>{data.session={access_token:'test-only',refresh_token:'test-only',expires_at:1};globalThis.fetch=async url=>{calls.push(url);return {ok:false,json:async()=>({message:'Invalid Refresh Token: Refresh Token Not Found'})};};await assert.rejects(rpc('is_admin'),/連携認証が切れ/);assert.equal(data.authProblem.reason,'refresh-invalid');await assert.rejects(rpc('is_admin'),/連携認証が切れ/);assert.equal(calls.length,1);globalThis.fetch=async()=>({ok:true,json:async()=>true});await connectSession({access_token:'new-test-only',refresh_token:'new-test-only',expires_at:Date.now()/1000+3600});assert.equal(data.authProblem,undefined);assert.equal(await rpc('is_admin'),true);});


test('4時間専用アラームは再起動で先送りせず、既存の毎分・日次アラームを保持する',async()=>{
 const alarms=new Map(),writes=[],api={get:async k=>alarms.get(k),create:async(k,v)=>{writes.push(k);alarms.set(k,{...v,scheduledTime:v.when});}};
 const last=now-30*60000;await ensureAlarms(api,{trackingHour:1,receiptHour:2},{now,lastPatrolAt:new Date(last).toISOString()});
 assert.equal(alarms.get('fm:seller-patrol').periodInMinutes,240);assert.equal(alarms.get('fm:seller-patrol').scheduledTime,last+240*60000);
 await ensureAlarms(api,{trackingHour:1,receiptHour:2},{now:now+60000,lastPatrolAt:new Date(now).toISOString()});
 assert.equal(writes.filter(x=>x==='fm:seller-patrol').length,1);
 assert.equal(alarms.get('fm:pulse').periodInMinutes,1);assert.equal(alarms.get('fm:update').periodInMinutes,1);
 alarms.delete('fm:seller-patrol');await ensureAlarms(api,{trackingHour:1,receiptHour:2},{now:now+300*60000,lastPatrolAt:new Date(last).toISOString()});
 assert.equal(alarms.get('fm:seller-patrol').scheduledTime,now+301*60000);
});
