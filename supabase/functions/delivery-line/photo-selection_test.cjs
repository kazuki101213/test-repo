const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),{test}=require('node:test'),assert=require('node:assert/strict');
const context={exports:{},Uint8Array,btoa,AbortSignal,fetch,URL,Response,TextDecoder,console};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(__dirname+'/photo-selection.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,context);
const {selectLinePhotos,listingImages,listingImageUrl,listingPage,parseSelection,boundedBytes}=context.exports;
const itemId='875763d1-939b-48c2-8aa4-f644c85ef39a',lease='11111111-1111-4111-8111-111111111111',listing={id:lease,channel:'メルカリ',externalId:'m77081516734'};
const jpeg=new Uint8Array([255,216,255,1,2,3]),photoUrl='https://static.mercdn.net/item/detail/orig/photos/m77081516734_4.jpg';
function fixture({local=true,noLabel=false,aiStatus=200,noImages=false}={}){
 const calls=[],ctx={itemId,lease,sku:'2294b-AAII-20261001-1450',model:'example',photos:local?[{id:'front',path:'front.jpg'},{id:'label',path:'label.jpg'}]:[],listing};
 const admin={rpc:async(name,args)=>{calls.push({name,args});return{data:name==='claim_line_photo_selection'?ctx:true};},storage:{from(bucket){return{download:async(path)=>{calls.push({download:path,bucket});return{data:new Blob([jpeg])};},upload:async(path,bytes)=>{calls.push({upload:path,bucket,bytes});return{};}};}}};
 const fetcher=async(url,options)=>{
  calls.push({url,options});
  if(url.includes('generativelanguage')){const body=JSON.parse(options.body);calls.push({aiBody:body});return new Response(JSON.stringify({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({overview:0,model:noLabel?null:local?1:0,overviewConfidence:.98,modelConfidence:noLabel?0:.97})}]}}]}),{status:aiStatus});}
  if(url===listingPage(listing))return new Response(noImages?'':`<script type="application/ld+json">${JSON.stringify({'@type':'Product',image:[photoUrl]})}</script>`);
  if(url===photoUrl)return new Response(jpeg);
  throw Error('Unexpected URL '+url);
 };
 return{calls,admin,fetcher,apiKey:'fixture-key',itemId};
}
test('App photos are prioritized, actual bytes classified and role IDs persisted without LINE sends',async()=>{
 const f=fixture(),result=await selectLinePhotos(f);assert.equal(result.saved,true);assert.equal(result.result.source,'app');assert.equal(result.result.model.id,'label');
 assert.equal(f.calls.filter(c=>c.download).length,2);assert(!f.calls.some(c=>c.url?.includes('mercari.com')));assert(!f.calls.some(c=>c.upload));
 const request=f.calls.find(c=>c.aiBody).aiBody,serialized=JSON.stringify(request);assert(!serialized.includes('2294b'));assert(!serialized.includes(itemId));assert(!serialized.includes('m77081516734'));
 assert.equal(request.contents[0].parts.filter(p=>p.inlineData).length,2);assert.equal(f.calls.at(-1).name,'finish_line_photo_selection');
});
test('No app photos: exact Mercari listing photos are fetched, imported and persisted',async()=>{
 const f=fixture({local:false}),result=await selectLinePhotos(f);assert.equal(result.saved,true);assert.equal(result.result.source,'メルカリ');
 assert.equal(f.calls.filter(c=>c.upload).length,2);assert(f.calls.every(c=>!c.download));assert(result.result.model.path.endsWith('-model.jpg'));
});
test('Unreadable model labels stay unset, never pick arbitrary second photo',async()=>{const f=fixture({noLabel:true}),result=await selectLinePhotos(f);assert.equal(result.saved,true);assert.equal(result.result.model,null);assert.equal(result.result.overview.id,'front');});
test('Temporary API failures persist retry state and do not throw into the dispatcher',async()=>{const f=fixture({aiStatus:429}),result=await selectLinePhotos(f);assert.equal(result.saved,false);assert.equal(f.calls.at(-1).args.p_error,'画像判定HTTP429');});
test('Missing listing images persist failure rather than inventing a photo or role',async()=>{const f=fixture({local:false,noImages:true}),result=await selectLinePhotos(f);assert.equal(result.saved,false);assert(!f.calls.some(c=>c.aiBody||c.upload));});
test('Out of range, low confidence and malformed AI selections are guarded',()=>{
 assert.throws(()=>parseSelection({overview:3,model:null,overviewConfidence:1,modelConfidence:0},2));
 assert.equal(parseSelection({overview:0,model:1,overviewConfidence:.9,modelConfidence:.3},2).model,null);
 assert.throws(()=>parseSelection({overview:0,model:1,overviewConfidence:2,modelConfidence:1},2));
});
test('Sources are exact listing IDs and trusted hosts; unrelated recommendations and redirects cannot enter',()=>{
 for(const url of['http://127.0.0.1/x.jpg','https://static.mercdn.net.evil.test/item/detail/orig/photos/m77081516734_4.jpg','https://static.mercdn.net/item/detail/orig/photos/m11111111111_1.jpg','https://name:pass@static.mercdn.net/item/detail/orig/photos/m77081516734_4.jpg'])assert.equal(listingImageUrl(url,listing),null);
 assert.equal(listingPage({...listing,externalId:'../../admin'}),null);
 assert.equal(listingImages(`<img src="https://static.mercdn.net/item/detail/orig/photos/m11111111111_1.jpg">`,listing).length,0);
 const yahoo={...listing,channel:'ヤフオク',externalId:'d1249591152'},url='https://auctions.c.yimg.jp/images.auctions.yahoo.co.jp/image/fixture/item.jpg';
 assert.equal(listingPage(yahoo),'https://page.auctions.yahoo.co.jp/jp/auction/d1249591152');
 const html=`<script type="application/ld+json">${JSON.stringify({'@type':'Product',url:listingPage(yahoo),image:[url]})}</script><img src="https://auctions.c.yimg.jp/unrelated.jpg">`;
 assert.deepEqual(Array.from(listingImages(html,yahoo)),[url]);
});
test('Responses are byte bounded even when Content-Length is omitted',async()=>{await assert.rejects(boundedBytes(new Response(new Uint8Array(100)),10));});
test('No queued work consumes no Gemini call',async()=>{const result=await selectLinePhotos({admin:{rpc:async()=>({data:null})},apiKey:'fixture',fetcher:()=>{throw Error('No requests');}});assert.equal(result.processed,0);});
