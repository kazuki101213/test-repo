// 新しい版の自動読み直しは「新しい版あり・1時間操作なし・入力途中の欄なし」のときだけ行うことを確かめる。
const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),assert=require('node:assert/strict');
const compile=f=>ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const ctx={exports:{},URL};
vm.runInNewContext(compile('packages/shared/src/releaseRefresh.ts'),ctx);
const {entryScriptFromHtml,entryScriptFromDocument,hasTypedInput,shouldReloadForRelease,RELEASE_IDLE_MS}=ctx.exports;

assert.equal(entryScriptFromHtml('<html><head><script type="module" crossorigin src="/assets/index-vGHZCgt2.js"></script></head></html>'),'/assets/index-vGHZCgt2.js');
assert.equal(entryScriptFromHtml('<script type="module" src="/src/main.tsx"></script>'),null,'開発中の画面は対象外');
assert.equal(entryScriptFromHtml('<!doctype html><p>not found</p>'),null);
const doc=src=>({querySelectorAll:()=>src.map(value=>({getAttribute:()=>value}))});
assert.equal(entryScriptFromDocument(doc(['https://test-repo-delivery.vercel.app/assets/index-AAA.js'])),'/assets/index-AAA.js');
assert.equal(entryScriptFromDocument(doc([])),null);

const base={current:'/assets/index-A.js',latest:'/assets/index-B.js',now:RELEASE_IDLE_MS+1,lastActivity:0,typedInput:false};
assert.equal(shouldReloadForRelease(base),true,'新しい版・1時間操作なし・入力なしなら読み直す');
assert.equal(shouldReloadForRelease({...base,latest:'/assets/index-A.js'}),false,'同じ版なら読み直さない');
assert.equal(shouldReloadForRelease({...base,latest:null}),false,'確認できなければ読み直さない');
assert.equal(shouldReloadForRelease({...base,lastActivity:base.now-60_000}),false,'使っている最中は読み直さない');
assert.equal(shouldReloadForRelease({...base,typedInput:true}),false,'入力途中の欄があれば読み直さない');
assert.equal(shouldReloadForRelease({...base,current:null}),false);

assert.equal(hasTypedInput([{isConnected:true,value:'説明文の下書き'}]),true);
assert.equal(hasTypedInput([{isConnected:true,value:'   '}]),false);
assert.equal(hasTypedInput([{isConnected:false,value:'閉じた欄'}]),false,'閉じた欄は対象外');
assert.equal(hasTypedInput([{isConnected:true,isContentEditable:true,textContent:'メモ'}]),true);
console.log('verify-release-refresh: ok');
