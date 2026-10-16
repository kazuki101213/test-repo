import {nextTime} from './core.js';
// Existing alarms survive worker suspension. Recreate only missing or changed alarms.
export async function ensureAlarms(alarms,settings,{now=Date.now(),fired=null}={}) {
 for(const [kind,hour] of [['tracking',settings.trackingHour],['receipt',settings.receiptHour]]) {
  const name='fm:'+kind,target=nextTime(hour,now),existing=await alarms.get(name);
  if(fired===name||!existing||Math.abs(existing.scheduledTime-target)>1000)await alarms.create(name,{when:target});
 }
 for(const [name,delay] of [['fm:pulse',60000],['fm:update',30000]]){
  const existing=await alarms.get(name);
  if(!existing||existing.periodInMinutes!==1)await alarms.create(name,{when:now+delay,periodInMinutes:1});
 }
}
