import { productModelText } from '../src/productModel.ts';
const eq=(actual: string,expected: string)=>{ if(actual!==expected)throw Error(`${actual} != ${expected}`); };
Deno.test('catalog model takes priority over an old title or FNSKU',()=>{
  eq(productModelText({model_no:'BDZ-FBW1000',title:'X001EMTLVR',marketplace:'動作品Amazon返品'}),'BDZ-FBW1000');
  eq(productModelText({model_no:'DMR-4T103',title:'old title',marketplace:'ヤフオク'}),'DMR-4T103');
});
Deno.test('unregistered return model never displays the FNSKU as a model',()=>{
  eq(productModelText({model_no:null,title:'X001EMTLVR',marketplace:'動作品Amazon返品'}),'未登録');
});
Deno.test('legacy manual model titles still display when no catalog model exists',()=>{
  eq(productModelText({model_no:null,title:'DBR-W2010',marketplace:'ヤフフリ'}),'DBR-W2010');
});
