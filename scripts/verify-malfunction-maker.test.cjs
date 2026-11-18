const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const ts=require('typescript');
const source=fs.readFileSync(path.join(__dirname,'../apps/admin/src/malfunctionMaker.ts'),'utf8');
const output=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const loaded={exports:{}};
new Function('exports','module',output)(loaded.exports,loaded);
const {malfunctionMaker}=loaded.exports;
test('manufacturer aliases include the existing catalog spellings and additional item details',()=>{
 for(const [value,expected]of [
  ['Panasonic','Panasonic'],['panasonic 白','Panasonic'],['Panasonic 18V 5.0Ah','Panasonic'],
  ['SONY','SONY'],['sony','SONY'],['SHARP　白','SHARP'],['SHARP　黒','SHARP'],
  ['TOSHIBA','TOSHIBA'],['toshiba 電源、コネクター','TOSHIBA'],['TOSHIBA リモコン有','TOSHIBA'],
 ])assert.equal(malfunctionMaker(value),expected,value);
});
test('Japanese, Latin, case, width, spaces, and kana variants identify the same manufacturer',()=>{
 for(const [value,expected]of [
  ['ＳＯＮＹ株式会社','SONY'],['ｿﾆｰ','SONY'],['ソニ－','SONY'],['そにー','SONY'],
  ['ﾊﾟﾅｿﾆｯｸ（Panasonic）','Panasonic'],['ぱなそにっく 白','Panasonic'],
  ['シャープ(SHARP)株式会社','SHARP'],['シヤープ','SHARP'],['SH ARP 白','SHARP'],
  ['東芝 TOSHIBA','TOSHIBA'],['トウシバ','TOSHIBA'],['とうしば','TOSHIBA'],
 ])assert.equal(malfunctionMaker(value),expected,value);
});
test('partial matching never treats Panasonic as Sony or chooses a brand from ambiguous metadata',()=>{
 assert.equal(malfunctionMaker('パナソニック'),'Panasonic');
 for(const value of ['SANYO','LG','Panasonic / SONY','SHARP、東芝',null,undefined,''])
  assert.equal(malfunctionMaker(value),null,String(value));
});
