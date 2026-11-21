// 「動作不良(返金待ち)(○日経過)」は返品完了の翌日（仕入先に届く日）から日本時間の日付で数える。
const fs=require('node:fs'),ts=require('typescript'),assert=require('node:assert/strict');
const src=fs.readFileSync('apps/admin/src/components/MalfunctionTasks.tsx','utf8');
const body=src.match(/export function refundWaitDays[\s\S]*?\r?\n\}\r?\n/);assert(body,'refundWaitDays not found');
const js=ts.transpileModule(body[0].replace('export ',''),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
const refundWaitDays=new Function(js+';return refundWaitDays;')();
const now=Date.parse('2026-11-21T07:30:00Z'); // 11/21 16:30 JST
assert.equal(refundWaitDays('2026-11-16T05:53:15Z',now),4,'11/16返品完了→11/17到着→11/21は4日経過');
assert.equal(refundWaitDays('2026-11-12T06:58:36Z',now),8);
assert.equal(refundWaitDays('2026-11-20T15:30:00Z',now),0,'11/21 0:30 JST の返品完了は到着前なので0日');
assert.equal(refundWaitDays('2026-11-20T14:30:00Z',now),0,'11/20 23:30 JST の返品完了は翌日11/21到着で0日');
assert.equal(refundWaitDays(null,now),null);
assert.match(src,/動作不良\(返金待ち\)\{/);
console.log('refund wait days: ok');
