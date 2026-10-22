const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript'), assert = require('node:assert/strict');
const hooks = []; let cursor = 0, dirty = true, effects = [], view;
const react = {
  useState(initial) { const i = cursor++; hooks[i] ??= { value: initial }; return [hooks[i].value, value => { hooks[i].value = typeof value === 'function' ? value(hooks[i].value) : value; dirty = true; }]; },
  useRef(current) { return hooks[cursor++] ??= { current }; },
  useCallback(fn, deps) { const i = cursor++; if (!hooks[i] || deps.some((v, n) => v !== hooks[i].deps[n])) hooks[i] = { fn, deps }; return hooks[i].fn; },
  useEffect(fn, deps) { const i = cursor++; if (!hooks[i] || deps.some((v, n) => v !== hooks[i].deps[n])) { hooks[i] = { deps }; effects.push(fn); } },
};
const context = { exports: {}, require: id => { assert.equal(id, 'react'); return react; }, Date };
vm.runInNewContext(ts.transpileModule(fs.readFileSync('apps/admin/src/hooks/usePurchaseDrafts.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, context);
const requests = [];
const fetchDrafts = () => new Promise((resolve, reject) => requests.push({ resolve, reject }));
async function settle() { for (let n = 0; n < 12; n++) { if (dirty) { cursor = 0; dirty = false; view = context.exports.usePurchaseDrafts(fetchDrafts); effects.splice(0).forEach(fn => fn()); } await Promise.resolve(); } }
(async () => {
  await settle(); assert.equal(requests.length, 1); assert.equal(view.loading, true);
  requests[0].resolve([{ id: 'existing' }]); await settle(); assert.equal(view.loading, false); assert.equal(view.updated, null);
  const refreshing = view.refresh(true); await settle(); assert.equal(view.loading, true);
  await view.refresh(true); assert.equal(requests.length, 2, 'double click must not issue another read');
  requests[1].resolve([{ id: 'existing' }, { id: 'new-purchase' }]); await refreshing; await settle();
  assert.equal(view.rows.length, 2); assert.equal(view.updated.count, 2); assert.match(view.updated.at, /\d+:\d+/); assert.equal(view.loading, false);
  const failed = view.refresh(true); await settle(); assert.equal(view.updated, null);
  requests[2].reject({ message: '接続できません' }); await failed; await settle();
  assert.equal(view.rows.length, 2, 'failure must preserve the visible list'); assert.equal(view.error, '接続できません'); assert.equal(view.loading, false);
  const retry = view.refresh(true); requests[3].resolve([]); await retry; await settle();
  assert.equal(view.rows.length, 0); assert.equal(view.error, null); assert.equal(view.updated.count, 0);
  const page = fs.readFileSync('apps/admin/src/pages/Inventory.tsx', 'utf8');
  assert(page.includes('disabled={draftsLoading || purchaseSync.syncing')); assert(page.includes('purchaseSync.startSync()'));assert(!page.includes('onClick={() => void loadPurchaseDrafts(true)}'));
  assert(!page.includes('フリマの購入・落札履歴から取得した下書きです。'));
  console.log('PASS: purchase refresh loading, duplicate prevention, new rows/count/time, failure preservation and successful retry');
})().catch(error => { console.error(error); process.exitCode = 1; });
