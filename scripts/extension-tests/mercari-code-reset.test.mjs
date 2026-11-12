import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareMercariShipping,advanceMercariShippingEditor,advanceMercariShippingSize,advanceMercariShippingPlace,sellerQueuedOperations} from '../../tools/fleamarket-extension/seller-runtime.js';
const desired='らくらくメルカリ便',alternate='ゆうゆうメルカリ便';
const job={id:'reset',external_id:'m12345678901',kind:'shipping_code',account_id:'mercari-2',channel:'メルカリ',url:'https://jp.mercari.com/transaction/m12345678901',payload:{shippingMethod:desired,size:'100',dropoff:'セブンイレブン'}};

test('既存ネコポスの同じ配送方法から直接遷移せず、一度無効化して元の方法へ戻した後だけ100サイズを設定する',async()=>{
 const expected=[desired,desired,desired,desired,alternate,desired,desired,desired,desired],calls=[],choices=[];
 let editorIndex=0;
 const result=await prepareMercariShipping({job,resetExistingCode:true,
  execute:async(fn,args)=>{
   calls.push({name:fn.name,...args});
   if(fn===advanceMercariShippingEditor){const index=editorIndex++;assert.equal(args.shippingMethod,expected[index]);return index===3?{methodAlreadySelected:true}:index===8?{sizeReady:true}:{step:index};}
   if(fn===advanceMercariShippingSize){assert.equal(editorIndex,9);assert.equal(args.shippingMethod,desired);assert.equal(args.size,'100');return {step:'size'};}
   assert.equal(fn,advanceMercariShippingPlace);assert.equal(args.dropoff,'セブンイレブン');return {step:'place'};
  },go:async()=>assert.fail('既存コードを残したサイズURLへの直接移動は禁止'),loaded:async()=>{},finishChoice:async(before,kind)=>choices.push({before,kind})});
 assert.equal(result.resetPreviousCode,true);assert.equal(calls.filter(x=>x.shippingMethod===alternate).length,1);
 assert.deepEqual(choices.slice(-2).map(x=>x.kind),['shipping-place','shipping-code-ready']);
 assert.equal(calls.some(x=>/shipping_code|ship_notice/.test(x.name)),false);
});

test('一時切替に失敗したらサイズ設定やコード生成へ進まない',async()=>{
 const calls=[];
 await assert.rejects(prepareMercariShipping({job,resetExistingCode:true,execute:async(fn,args)=>{calls.push(fn.name);if(args.shippingMethod===alternate)throw Error('配送方法の変更失敗');return {methodAlreadySelected:true};},go:async()=>assert.fail(),loaded:async()=>{},finishChoice:async()=>{}}),/配送方法の変更失敗/);
 assert.deepEqual(calls,['advanceMercariShippingEditor','advanceMercariShippingEditor']);
});

test('発行前の選択済み配送方法は一時切替せず通常のサイズ画面へ進む',async()=>{
 const navigations=[],methods=[];let checks=0;
 const result=await prepareMercariShipping({job,execute:async(fn,args)=>{if(fn===advanceMercariShippingEditor){methods.push(args.shippingMethod);return checks++?{sizeReady:true}:{methodAlreadySelected:true};}return {prepared:true};},go:async url=>navigations.push(url),loaded:async()=>{},finishChoice:async()=>{}});
 assert.equal(result.resetPreviousCode,false);assert.deepEqual(methods,[desired,desired]);assert.deepEqual(navigations,[job.url+'/shipping_class']);
});

test('匿名配送以外へ切り替えてコードをリセットしない',async()=>{
 const unsupported={...job,payload:{...job.payload,shippingMethod:'上記以外の方法で発送する'}};let calls=0;
 await assert.rejects(prepareMercariShipping({job:unsupported,resetExistingCode:true,execute:async()=>{calls++;return {methodAlreadySelected:true};},go:async()=>assert.fail(),loaded:async()=>{},finishChoice:async()=>{}}),/匿名配送/);assert.equal(calls,1);
});

test('配送方法を戻せない場合は一時切替を繰り返さず上限で停止する',async()=>{
 let alternateCount=0,sizeCount=0;
 await assert.rejects(prepareMercariShipping({job,resetExistingCode:true,execute:async(fn,args)=>{if(fn===advanceMercariShippingSize)sizeCount++;if(args.shippingMethod===alternate){alternateCount++;return {changed:true};}return {methodAlreadySelected:true};},go:async()=>{},loaded:async()=>{},finishChoice:async()=>{}}),error=>{assert.equal(error.shippingEvidence.resetUsed,true);return /画面遷移/.test(error.message);});
 assert.equal(alternateCount,1);assert.equal(sizeCount,0);
});

test('既存コードがある再発行だけリセットを許し、最終サイズ不一致では成功にしない',async()=>{
 for(const existing of [false,true]){
  let options,finished,reads=0;
  await sellerQueuedOperations({settings:{mode:'tracking',accounts:[{id:'mercari-2',site:'mercari',enabled:true}]},rpc:async(name,args)=>name==='extension_seller_queue'?[job]:name==='extension_claim_seller_operation'?true:(finished=args),log:async()=>{},openSession:async()=>({go:async()=>{},prepareShipping:async(_job,value)=>{options=value;},operation:async(_job,phase)=>{if(phase==='shipping_preflight')return reads++?{methodMatches:true,sizeMatches:false,configuredSize:'ネコポス',configuredDropoff:'セブンイレブン',readyForCode:false}:{needsEditor:true,configuredSize:existing?'ネコポス':null,readyForCode:!existing};assert.fail('不一致のままコードを取得しない');},close:async()=>{}})});
  assert.deepEqual(options,{resetExistingCode:existing});assert.equal(finished.p_status,'uncertain');assert.match(finished.p_result.note,/配送サイズ/);assert.equal(finished.p_result.qr_code,undefined);
 }
});
