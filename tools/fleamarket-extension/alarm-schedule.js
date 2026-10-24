import {nextTime} from './core.js';
import {IDLE_CHECK_MINUTES,UPDATE_CHECK_MINUTES,ACTIVE_WORK_MINUTES} from './runtime-policy.js';
// Existing alarms survive worker suspension. Recreate only missing or changed alarms.
export async function ensureAlarms(alarms,settings,{now=Date.now(),fired=null,lastPatrolAt=null}={}) {
 for(const [kind,hour] of [['tracking',settings.trackingHour],['receipt',settings.receiptHour]]) {
  const name='fm:'+kind,target=nextTime(hour,now),existing=await alarms.get(name);
  if(fired===name||!existing||Math.abs(existing.scheduledTime-target)>1000)await alarms.create(name,{when:target});
 }
 for(const [name,minutes] of [['fm:pulse',IDLE_CHECK_MINUTES],['fm:update',UPDATE_CHECK_MINUTES]]){
  const existing=await alarms.get(name);
  if(!existing||existing.periodInMinutes!==minutes)await alarms.create(name,{when:now+minutes*60000,periodInMinutes:minutes});
 }
 const patrol=await alarms.get('fm:seller-patrol');
 if(!patrol||patrol.periodInMinutes!==240){
  const last=Date.parse(lastPatrolAt||''),when=Number.isFinite(last)?Math.max(now+60000,last+240*60000):now+60000;
  await alarms.create('fm:seller-patrol',{when,periodInMinutes:240});
 }
}
// This one-shot alarm exists only while a multi-step job needs continuation.
export async function ensureActiveWorkAlarm(alarms,active,{now=Date.now()}={}){
 const existing=await alarms.get('fm:work');
 if(active&&!existing)await alarms.create('fm:work',{when:now+ACTIVE_WORK_MINUTES*60000});
 else if(!active&&existing)await alarms.clear('fm:work');
}
