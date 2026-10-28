import test from 'node:test';
import assert from 'node:assert/strict';
import {openSellerSession} from '../../tools/fleamarket-extension/seller-runtime.js';

test('rating audit uses the same buyer preflight validator as submission',async()=>{
  let tab={id:78,url:'https://auctions.yahoo.co.jp/my/won',status:'complete'};
  const calls=[];
  const tabs={query:async()=>[tab],get:async()=>tab,update:async(id,value)=>(tab={...tab,...value})};
  const session=await openSellerSession({id:'auctions-1',site:'auctions',identity:{pageUrl:tab.url}},{
    tabs,identity:async()=>({confirmed:true}),
    scripting:{executeScript:async({func,args})=>{calls.push([func.name,args[0]]);return [{result:{itemId:'k1246920217',buyer:true,seller:false,evaluated:false,newEvaluation:true}}];}}
  });
  await session.go('https://auctions.yahoo.co.jp/jp/show/leavefeedback?aID=k1246920217');
  const result=await session.buyerTodo({itemId:'k1246920217',stage:'rating'});
  assert.equal(result.newEvaluation,true);
  assert.equal(calls.at(-1)[0],'yahooRatingPage');
  assert.deepEqual(calls.at(-1)[1],{itemId:'k1246920217',action:'buyerPreflight'});
  await session.close();
});
