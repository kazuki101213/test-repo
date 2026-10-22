const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),assert=require('node:assert/strict');
function load(file,imports={},context={}){const c={exports:{},require:id=>imports[id]??{},...context};vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,c);return c.exports;}
const {appendListingKeywords:append}=load('apps/delivery/src/listingKeywords.ts');
const body='手入力の本文\n\nAI生成による検索用\nブルーレイ BD\n【2500-test】';
const next=append(body,'BD レコーダー 録画機',[],'2500-test');
assert.equal(next,'手入力の本文\n\nAI生成による検索用\nブルーレイ BD レコーダー 録画機\n【2500-test】');
assert.equal(append(next,'BD レコーダー 録画機',['BD レコーダー 録画機'],'2500-test'),next);
assert.equal(append('原文 AI旧語\n【sku】','AI新語',['AI旧語'],'sku'),'原文 AI旧語 AI新語\n【sku】');
assert.equal(append('内容\n\nAI生成による検索用\n既存語　【sku】','追加語',[],'sku'),'内容\n\nAI生成による検索用\n既存語 追加語　【sku】');
const description=load('apps/delivery/src/description.ts',{'./descriptionTemplates':load('apps/delivery/src/descriptionTemplates.ts')});
for(const condition of description.CONDITIONS_BY_TARGET['yahoo-auction']){
 const output=description.buildDescription({product:'ブルーレイレコーダー',condition,accessories:'',year:'',target:'yahoo-auction',inspected:false,cleaned:false,salesChannel:'ヤフオク',sku:'2403-test',modelNo:'DBR-T1009',manufacturer:'TOSHIBA'});
 assert(!output.includes('破損あります'),'A condition rating is not evidence of physical damage');
 assert(output.includes('知人宅で通常通り使用してました。'));
}
assert.equal(description.conditionForTarget('yahoo-auction','可'),'傷や汚れあり','Condition mapping is preserved');
async function hooks(){
 let state=[],index=0,effects=[],timer,apiCalls=0,resolve,applied=[];
 const react={useRef(value){const i=index++;state[i]??={current:value};return state[i];},useState(value){const i=index++;if(!(i in state))state[i]=value;return[state[i],v=>{state[i]=typeof v==='function'?v(state[i]):v;}];},useEffect(fn,deps){const i=index++;if(!state[i]||deps.some((v,n)=>v!==state[i].deps[n])){state[i]?.cleanup?.();state[i]={deps};effects.push(()=>state[i].cleanup=fn());}}};
 const {useListingKeywords}=load('apps/delivery/src/useListingKeywords.ts',{'react':react,'./api':{generateListingKeywords:async()=>{apiCalls++;return await new Promise(r=>resolve=r);}},'./listingKeywords':{appendListingKeywords:append}},{window:{setTimeout:fn=>(timer=fn,1),clearTimeout:()=>{timer=undefined;}}});
 const input={itemId:'item',target:'mercari',title:'Aprica ラクリス',body:'原文\nAI生成による検索用\n抱っこひも',category:'小物',manufacturer:'Aprica',sku:'sku',disabled:false,apply:v=>applied.push(v)};
 function render(){index=0;const hook=useListingKeywords(input);effects.splice(0).forEach(fn=>fn());return hook;}
 render();await timer();assert.equal(apiCalls,1);input.body+=' 手入力';render();resolve({keywords:'ベビーキャリア',previous:[],cached:false});for(let i=0;i<8;i++)await Promise.resolve();assert.equal(applied.length,0,'editing while Gemini runs must be preserved');
 input.target='amazon';render();assert.equal(timer,undefined);assert.equal(apiCalls,1,'Amazon never generates');
 input.target='yahoo-auction';render();await timer();assert.equal(apiCalls,2);resolve({keywords:'ベビーキャリア',previous:[],cached:true});for(let i=0;i<8;i++)await Promise.resolve();assert.equal(applied.length,1);assert(applied[0].endsWith('手入力 ベビーキャリア'));
 input.title='別の商品';render();await timer();input.disabled=true;render();resolve({keywords:'追加語',previous:[],cached:false});for(let i=0;i<8;i++)await Promise.resolve();assert.equal(applied.length,1,'saving/listing while Gemini runs must not be overwritten');
 const hook=render();assert.equal(hook.busy,false);
}
hooks().then(()=>console.log('PASS: append inline, fixed words/SKU preserved, idempotency, automatic generation, manual-edit/save race protection and Amazon exclusion')).catch(e=>{console.error(e);process.exitCode=1;});
