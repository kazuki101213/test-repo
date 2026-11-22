const fs=require('node:fs'),ts=require('typescript'),vm=require('node:vm'),assert=require('node:assert/strict');
const ctx={exports:{}};vm.runInNewContext(ts.transpileModule(fs.readFileSync('apps/admin/src/mercariSearch.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,ctx);
const {mercariSearchUrl}=ctx.exports;
assert.equal(mercariSearchUrl('EZ3582'),'https://jp.mercari.com/search?keyword=EZ3582');
assert.equal(mercariSearchUrl(' ＥＣＭ－Ｇ1 '),'https://jp.mercari.com/search?keyword=ECM-G1');
assert.equal(mercariSearchUrl('Vixen　ポラリエ U'),'https://jp.mercari.com/search?keyword='+encodeURIComponent('Vixen ポラリエ U'));
const page=fs.readFileSync('apps/admin/src/pages/Products.tsx','utf8');
assert(page.includes("href={mercariSearchUrl(p.model_no)}")&&page.includes('をメルカリで検索'),'Model number cell links to Mercari search');
console.log('PASS: model number links to Mercari search results');
