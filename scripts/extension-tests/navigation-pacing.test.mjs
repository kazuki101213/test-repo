import test from 'node:test';
import assert from 'node:assert/strict';
import {createNavigationPacer,pacedTabs,NAVIGATION_INTERVAL_MS} from '../../tools/fleamarket-extension/navigation-pacing.js';
test('navigation queue serializes and persists intervals without retrying failures',async()=>{
 let time=100000;const waits=[],calls=[],saved={navigationLastAt:98000};
 const pace=createNavigationPacer({now:()=>time,sleep:async ms=>{waits.push(ms);time+=ms;},storage:{get:async()=>saved,set:async value=>Object.assign(saved,value)}});
 const first=pace(async()=>{calls.push(time);throw Error('access restriction');});
 const second=pace(async()=>calls.push(time));
 await assert.rejects(first,/restriction/);await second;
 assert.deepEqual(waits,[6000,NAVIGATION_INTERVAL_MS]);assert.deepEqual(calls,[106000,114000]);assert.equal(saved.navigationLastAt,114000);
});
test('same URL reuses page and active-only changes do not reload',async()=>{
 const calls=[];const tabs={get:async()=>({url:'https://jp.mercari.com/mypage'}),update:async(...args)=>calls.push(args)};
 const wrapped=pacedTabs(tabs);await wrapped.update(1,{url:'https://jp.mercari.com/mypage'});assert.equal(calls.length,0);
 await wrapped.update(1,{active:true});assert.deepEqual(calls,[[1,{active:true}]]);assert.equal(pacedTabs(wrapped),wrapped);
});
test('user navigation during queue wait stops before URL update',async()=>{
 let calls=0,reads=0;const tabs={get:async()=>({url:++reads===1?'https://jp.mercari.com/mypage':'https://jp.mercari.com/item/m123'}),update:async()=>calls++};
 await assert.rejects(pacedTabs(tabs).update(1,{url:'https://jp.mercari.com/mypage/purchases'}),/待機中/);assert.equal(calls,0);
});
