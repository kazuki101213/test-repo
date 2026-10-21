const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),assert=require('node:assert/strict');
const compile=p=>ts.transpileModule(fs.readFileSync(p,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const urls={exports:{}};vm.runInNewContext(compile('packages/shared/src/noticeUrl.ts'),urls);
let calls=[],opened; const jsx=(type,props)=>({type,props});
const context={exports:{},URL,require:n=>n==='react'?{useState:v=>[v,()=>{}]}:n==='react/jsx-runtime'?{jsx,jsxs:jsx}:n==='@bussan/shared'?urls.exports:n==='../api'?{findInventoryForSpare:async serial=>{calls.push(serial);return{id:'correct-suffix-item'}}}:n==='../appUrls'?{deliveryAppUrl:'https://test-repo-delivery.vercel.app/'}:{},window:{location:{href:'https://bussan-admin.vercel.app/',assign:url=>opened=url}}};
vm.runInNewContext(compile('apps/admin/src/components/SpareLinks.tsx'),context);
function all(n,out=[]){if(Array.isArray(n))n.forEach(v=>all(v,out));else if(n&&typeof n==='object'){out.push(n);all(n.props?.children,out)}return out;}
(async()=>{const component=context.exports.default;
for(const [marketplace,marketplace_item_id,url] of [['ヤフオク','1243959352','https://auctions.yahoo.co.jp/jp/auction/1243959352'],['メルカリ','m12345','https://jp.mercari.com/item/m12345']])assert.equal(component({row:{marketplace,marketplace_item_id},kind:'product'}).props.href,url);
assert.equal(component({row:{marketplace:'その他',marketplace_item_id:'javascript:bad'},kind:'product'}),null);
const tree=component({row:{usage_note:'1904a'},kind:'usage'});assert.equal(calls.length,0,'No background per-row lookup');all(tree).find(n=>n.type==='button').props.onClick();await new Promise(setImmediate);assert.equal(calls[0],'1904a');assert.equal(new URL(opened).searchParams.get('itemId'),'correct-suffix-item');assert.equal(component({row:{usage_note:null},kind:'usage'}),null);console.log('PASS: supplier URL, legacy numeric Yahoo ID, exact suffix usage link and no eager lookup');})().catch(e=>{console.error(e);process.exitCode=1});
