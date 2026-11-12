import test from 'node:test';
import assert from 'node:assert/strict';
import {openYahooSupplierMessages} from '../../tools/fleamarket-extension/yahoo-supplier-message.js';

const original='x123', representative='p456';
const parent={id:representative,url:'parent'};
const message={messageUrl:'messages'};
const fixture=(proof=[original,representative])=>{
  const visited=[];
  let page='item';
  return {visited,navigate:async next=>{visited.push(next);page=next;},inspect:async(id,open)=>{
    if(open){assert.equal(id,representative);assert.equal(page,'parent');return message;}
    if(page==='item'){assert.equal(id,original);return {isChild:true,parent,bundleUrl:'bundle'};}
    if(page==='bundle'){assert.equal(id,original);return {itemIds:proof};}
    throw Error('Unexpected inspection');
  }};
};

test('the child and representative must appear in the same bundle before opening messages',async()=>{
  const f=fixture();
  assert.equal(await openYahooSupplierMessages({itemId:original,...f}),representative);
  assert.deepEqual(f.visited,['bundle','parent','messages']);
});

test('a different bundle cannot receive the message',async()=>{
  const f=fixture([representative,'z789']);
  await assert.rejects(openYahooSupplierMessages({itemId:original,...f}),/同じまとめて取引/);
  assert.deepEqual(f.visited,['bundle']);
});

test('an ordinary transaction stays on the same auction',async()=>{
  const visited=[];
  const id=await openYahooSupplierMessages({itemId:original,inspect:async(id,open)=>{
    assert.equal(id,original);
    return open?message:{isChild:false,parent:null};
  },navigate:async url=>visited.push(url)});
  assert.equal(id,original);
  assert.deepEqual(visited,['messages']);
});

test('the child cannot send when the representative is missing',async()=>{
  await assert.rejects(openYahooSupplierMessages({itemId:original,
    inspect:async()=>({isChild:true,parent:null}),
    navigate:async()=>assert.fail('must stop before opening messages')
  }),/代表を確認できません/);
});
