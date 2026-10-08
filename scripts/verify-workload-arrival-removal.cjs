const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),assert=require('node:assert/strict'),path=require('node:path');
const root=path.resolve(__dirname,'..');
const compile=f=>ts.transpileModule(fs.readFileSync(path.join(root,f),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
class FixedDate extends Date { constructor(...args){super(...(args.length?args:['2026-10-08T02:00:00Z']));} }
const period={exports:{},Date:FixedDate};vm.runInNewContext(compile('apps/admin/src/workloadPeriod.ts'),period);
assert.equal(period.exports.workloadPeriod(new Date('2026-05-31T00:00:00Z')).averageStart,'2026-02-28');
assert.equal(period.exports.workloadPeriod(new Date('2026-09-30T16:00:00Z')).monthStart,'2026-10-01');
const inventory={exports:{}};vm.runInNewContext(compile('apps/admin/src/inventory.ts'),inventory);
let calls=[],source=[];
const shared={getSupabase:()=>({from(table){const conditions=[];const q={select(s){assert(!s.includes('arrived_on'));calls.push(['select',s]);return q;},eq(k,v){conditions.push(r=>r[k]===v);calls.push(['eq',k,v]);return q;},gte(k,v){conditions.push(r=>r[k]>=v);return q;},lte(k,v){conditions.push(r=>r[k]<=v);return q;},not(k,op,v){conditions.push(r=>r[k]!=null);calls.push(['not',k,op,v]);return q;},order(){return q;},range(from,to){calls.push(['range',from,to]);return Promise.resolve({data:source.filter(r=>conditions.every(c=>c(r))).slice(from,to+1),error:null});}};return q;}})};
const api={exports:{},require:id=>id==='@bussan/shared'?shared:id==='./inventory'?inventory.exports:id==='./workloadPeriod'?period.exports:{}};vm.runInNewContext(compile('apps/admin/src/api.ts'),api);
let cursor=0,hooks=[],pending=[],dirty=true,tree;
const react={useState(v){const n=cursor++;if(!hooks[n])hooks[n]={value:v};return[hooks[n].value,next=>{hooks[n].value=next;dirty=true;}];},useRef(v){return hooks[cursor++]??={current:v};},useEffect(fn,deps){const n=cursor++;if(!hooks[n]||deps.some((v,i)=>v!==hooks[n].deps[i])){hooks[n]?.cleanup?.();const h=hooks[n]={deps};pending.push(()=>h.cleanup=fn());}}};
const jsx=(type,props)=>({type,props});
const view={exports:{},Date,require:id=>id==='react'?react:id==='react/jsx-runtime'?{jsx,jsxs:jsx}:id==='../api'?api.exports:id==='../inventory'?inventory.exports:{default:'component'}};
vm.runInNewContext(compile('apps/admin/src/components/WorkloadDetail.tsx'),view);
function text(n){return n==null?'':Array.isArray(n)?n.map(text).join(''):typeof n==='object'?text(n.props?.children):String(n);}
function all(n,out=[]){if(!n||typeof n!=='object')return out;if(Array.isArray(n)){n.forEach(x=>all(x,out));return out;}out.push(n);all(n.props?.children,out);return out;}
(async()=>{
 source=Array.from({length:1001},(_,i)=>({id:String(i),deliverer_id:'II',status:'作業中',is_accessory:false,sku:`${i}-AAII-0-0`,lot_seq:i,marketplace:i%2?'Amazon返品':'ヤフオク',title:'商品',purchased_at:'2026-09-01',shipped_on:null}));
 source.push({...source[0],id:'accessory',is_accessory:true},{...source[0],id:'sold',status:'販売済',shipped_on:null},{...source[0],id:'listed',status:'出品中',shipped_on:'2026-09-11'});
 const working=await api.exports.fetchWorkloadDetail('II','作業中');assert.equal(working.length,1001);assert(working.some(r=>r.marketplace==='Amazon返品'));assert(calls.filter(c=>c[0]==='range').length>=3);assert(calls.some(c=>c[0]==='eq'&&c[1]==='status'&&c[2]==='作業中'));
 calls=[];source=[{...source[0],id:'one',packed_on:'2026-09-11',shipped_on:'2026-09-30'},{...source[0],id:'two',packed_on:'2026-09-21',shipped_on:null},{...source[0],id:'no-purchase',purchased_at:null,packed_on:'2026-09-21'},{...source[0],id:'no-packing',packed_on:null},{...source[0],id:'old',packed_on:'2026-07-07'},{...source[0],id:'future',packed_on:'2026-10-09'},{...source[0],id:'packed-accessory',is_accessory:true,packed_on:'2026-09-11'}];
 const rows=await api.exports.fetchWorkloadDetail('II','平均作業日数');assert.equal(rows.length,2);assert(calls.some(c=>c[0]==='not'&&c[1]==='purchased_at'));
 for(let i=0;i<12;i++){if(dirty){cursor=0;dirty=false;tree=view.exports.default({delivererId:'II',name:'担当者',metric:'平均作業日数',onClose(){}});pending.splice(0).forEach(fn=>fn());}await Promise.resolve();}
 const rendered=text(tree);assert(rendered.includes('平均 15.0日'));assert(!rendered.includes('入荷日'));assert(rendered.includes('仕入日から梱包日'));assert.deepEqual(all(tree).filter(n=>n.type==='th').map(text),['通番号','商品・仕入先','状況','仕入日','梱包日','出荷日','作業日数']);
 source=[{...source[0],id:'packed',packed_on:'2026-10-01',shipped_on:null},{...source[0],id:'shipped',packed_on:'2026-09-30',shipped_on:'2026-10-01'},{...source[0],id:'accessory',is_accessory:true,packed_on:'2026-10-01',shipped_on:'2026-10-01'},{...source[0],id:'future',packed_on:'2026-10-09',shipped_on:'2026-10-09'}];
 assert.deepEqual(Array.from(await api.exports.fetchWorkloadDetail('II','梱包済'),x=>x.id),['packed']);
 assert.deepEqual(Array.from(await api.exports.fetchWorkloadDetail('II','出荷済'),x=>x.id),['shipped']);
 const constants={exports:{}};vm.runInNewContext(compile('packages/shared/src/constants.ts'),constants);assert(!constants.exports.STATUSES.includes('保留'));assert(!constants.exports.STATUSES.includes('廃棄'));
 console.log('1001-row working query including Amazon returns, selected work status, main-only monthly packing/shipping, three-month packed-date average, date boundaries and seven-column detail passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
