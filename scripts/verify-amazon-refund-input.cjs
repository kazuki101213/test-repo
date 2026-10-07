const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),assert=require('node:assert/strict');
let update;
const query={update:value=>{update=value;return query;},eq:()=>query,select:()=>query,maybeSingle:async()=>({data:{id:'item'},error:null})};
const shared={getSupabase:()=>({from:()=>query})};
const context={exports:{},require:name=>name==='@bussan/shared'?shared:{},Number,Set};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('apps/admin/src/api.ts','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,context);
(async()=>{
 const item={id:'item',updated_at:'original'};
 await context.exports.updateInventoryField(item,'amazon_refund_amount','-1234');
 assert.equal(update.amazon_refund_amount,-1234);
 await context.exports.updateInventoryField(item,'amazon_refund_amount','1234');
 assert.equal(update.amazon_refund_amount,1234);
 await assert.rejects(context.exports.updateInventoryField(item,'amazon_refund_amount','1.5'));
 for(const field of ['cost_amount','inventory_refund_amount','non_amazon_refund_amount'])await assert.rejects(context.exports.updateInventoryField(item,field,'-1234'));
 console.log('Signed Amazon refund accepted; fractions and negative other amounts rejected');
})().catch(e=>{console.error(e);process.exitCode=1;});
