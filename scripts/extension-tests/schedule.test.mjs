import test from 'node:test';
import assert from 'node:assert/strict';
import {scheduleDue} from '../../tools/fleamarket-extension/schedule.js';
const at=time=>Date.parse('2026-10-06T'+time+':00+09:00');
test('manual check before 01:00 does not skip daily run',()=>{
 const records={lastRun:{tracking:{day:'2026-10-06',manual:true}}};
 assert.equal(scheduleDue('tracking',1,records,at('00:59')),false);
 assert.equal(scheduleDue('tracking',1,records,at('01:00')),true);
});
test('late Chrome startup catches up even after 13:00',()=>assert.equal(scheduleDue('tracking',1,{},at('18:30')),true));
test('automatic attempt prevents same-day repeated site visits, and next day runs',()=>{
 const records={scheduledRuns:{tracking:{day:'2026-10-06'}}};
 assert.equal(scheduleDue('tracking',1,records,at('18:30')),false);
 assert.equal(scheduleDue('tracking',1,records,Date.parse('2026-10-07T01:00:00+09:00')),true);
});
test('migration preserves automatic history after a manual retry',()=>{
 const records={lastRun:{tracking:{day:'2026-10-06',access:{manual:true}}},trackingAccessHistory:[{day:'2026-10-06',manual:false}]};
 assert.equal(scheduleDue('tracking',1,records,at('18:30')),false);
});
test('manual-only history permits scheduled run and legacy unknown prevents duplicate',()=>{
 assert.equal(scheduleDue('tracking',1,{lastRun:{tracking:{day:'2026-10-06',access:{manual:true}}}},at('02:00')),true);
 assert.equal(scheduleDue('tracking',1,{lastRun:{tracking:{day:'2026-10-06'}}},at('02:00')),false);
});
