const fs=require('fs'),vm=require('vm'),ts=require('typescript'),assert=require('assert/strict');
const compile=file=>ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const all=(n,out=[])=>{if(Array.isArray(n))n.forEach(x=>all(x,out));else if(n&&typeof n==='object'){out.push(n);all(n.props?.children,out);}return out;};
const text=n=>n==null?'':Array.isArray(n)?n.map(text).join(''):typeof n==='object'?text(n.props?.children):String(n);
let cursor=0,hooks=[],effects=[],dirty=true,tree,historyCalls=[];
const react={useState(initial){const i=cursor++;if(!hooks[i])hooks[i]={value:typeof initial==='function'?initial():initial};return[hooks[i].value,v=>{hooks[i].value=typeof v==='function'?v(hooks[i].value):v;dirty=true;}];},useEffect(fn,deps){const i=cursor++;if(!hooks[i]||deps.some((x,j)=>x!==hooks[i].deps[j])){hooks[i]?.cleanup?.();hooks[i]={deps};effects.push(()=>{hooks[i].cleanup=fn();});}}};
const product={id:'p',asin:'BTEST00001',model_no:'MODEL',amazon_url:'https://www.amazon.co.jp/dp/BTEST00001'};
let history=[{id:'sale',product_id:'p',sku:'sale-SKU',sold_on:'2026-10-10',sold_price:301,payout_amount:270,sales_channel:'FBA'}];
const api={fetchProducts:async()=>[product],fetchProductSaleSummaries:async()=>[{product_id:'p',history_count:5,amazon_count:3,amazon_average:301}],fetchProductSaleHistory:async rows=>{historyCalls.push(rows);return history;}};
const jsx=(type,props)=>({type,props});const ctx={exports:{},require:id=>id==='react'?react:id==='react/jsx-runtime'?{jsx,jsxs:jsx}:id==='@bussan/shared'?{yen:n=>n==null?'—':'¥'+n}:id==='../api'?api:{default:'stub'},setTimeout:fn=>{fn();return 1;},clearTimeout(){}};
vm.runInNewContext(compile('apps/admin/src/pages/Products.tsx'),ctx);
async function settle(){for(let i=0;i<25;i++){if(dirty){cursor=0;dirty=false;tree=ctx.exports.default();effects.splice(0).forEach(f=>f());}await Promise.resolve();}}
(async()=>{
 await settle();assert.equal(historyCalls.length,0,'List must not fetch sale history');assert(text(tree).includes('¥301'));assert(text(tree).includes('3件'));
 all(tree).find(n=>n.type==='button'&&n.props.title==='直近3件のAmazon販売金額の平均').props.onClick();await settle();
 assert.equal(historyCalls.length,1);assert.equal(historyCalls[0].length,1);assert.equal(historyCalls[0][0].id,'p');assert(text(tree).includes('sale-SKU'));assert(text(tree).includes('¥270'));
 all(tree).find(n=>n.type==='button'&&text(n)==='閉じる').props.onClick();await settle();
 api.fetchProductSaleHistory=async()=>{throw Error('history unavailable');};
 all(tree).find(n=>n.type==='button'&&n.props.title==='直近3件のAmazon販売金額の平均').props.onClick();await settle();
 assert(text(tree).includes('history unavailable'));assert(!text(tree).includes('sale-SKU'),'Failed history must not show a stale record');
 console.log('Product list summary only, same displayed average, selected-product history on demand and visible failure passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
