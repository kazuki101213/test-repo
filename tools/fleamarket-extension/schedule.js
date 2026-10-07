import {dueTime,jstDay} from './core.js';
// Manual checks do not consume the daily schedule. An automatic attempt runs once per JST day.
export function scheduledToday(kind,day,{scheduledRuns={},lastRun={},trackingAccessHistory=[]}={}) {
  if(scheduledRuns[kind]?.day===day)return true;
  if(kind==='tracking'&&trackingAccessHistory.some(r=>r.day===day&&r.manual===false))return true;
  const previous=lastRun[kind];
  if(previous?.day!==day)return false;
  const manual=previous.manual??previous.access?.manual;
  // Preserve unknown legacy completion records, preventing a duplicate after migration.
  return manual!==true;
}
export function scheduleDue(kind,hour,records,now=Date.now()) {
  return now>=dueTime(hour,now)&&!scheduledToday(kind,jstDay(now),records);
}
