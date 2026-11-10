const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const assert = require('node:assert/strict');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const compile = file => ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const inventory = { exports: {} };
vm.runInNewContext(compile('apps/admin/src/inventory.ts'), inventory);

const source = Array.from({ length: 1001 }, (_, i) => ({
  id: String(i), deliverer_id: 'II', bucket: '手元出品', on_hand: true,
}));
source.push({ id: 'other-assignee', deliverer_id: 'EE', bucket: '手元出品', on_hand: true });
source.push({ id: 'fba', deliverer_id: 'II', bucket: 'FBA出品', on_hand: false });
source.push({ id: 'registration', deliverer_id: 'II', bucket: '登録前', on_hand: true });
source.push({ id: 'amazon-return', deliverer_id: 'II', bucket: 'Amazon返品', on_hand: false });
source.push({ id: 'other-amazon-return', deliverer_id: 'EE', bucket: 'Amazon返品', on_hand: false });
const ranges = [];
const shared = {
  getSupabase: () => ({
    from(table) {
      assert.equal(table, 'v_deliverer_stock_workload_items');
      const conditions = [];
      const query = {
        select(fields) {
          assert(fields.includes('model_no'));
          assert(!fields.includes('arrived_on'));
          return query;
        },
        eq(key, value) {
          conditions.push(row => row[key] === value);
          return query;
        },
        order() { return query; },
        async range(from, to) {
          ranges.push([from, to]);
          return { data: source.filter(row => conditions.every(matches => matches(row))).slice(from, to + 1), error: null };
        },
      };
      return query;
    },
  }),
};
const api = { exports: {}, require: name => name === '@bussan/shared' ? shared : name === './inventory' ? inventory.exports : {} };
vm.runInNewContext(compile('apps/admin/src/api.ts'), api);

(async () => {
  const { fetchWorkloadDetail, workloadMetrics } = api.exports;
  const metric = key => workloadMetrics.find(entry => entry.key === key);
  assert.deepEqual(Array.from(workloadMetrics, entry => entry.label), [
    '手元にある在庫', '受取前', '検品中', 'Amazon返品', '商品登録前', '出品中・手元', '出品中・FBA倉庫',
    '取引中・発送前', '取引中・発送済み', '動作不良・手元',
  ]);
  assert.equal((await fetchWorkloadDetail('II', metric('listed_on_hand'))).length, 1001);
  assert(ranges.length > 1);
  assert.equal((await fetchWorkloadDetail('II', metric('on_hand'))).length, 1002);
  assert.equal((await fetchWorkloadDetail('II', metric('listed_in_fba')))[0].id, 'fba');
  const amazonReturns = await fetchWorkloadDetail('II', metric('amazon_returns'));
  assert.deepEqual(Array.from(amazonReturns, item => item.id), ['amazon-return']);
  console.log('Workload detail preserves the selected person and metric through pagination.');
})().catch(error => { console.error(error); process.exitCode = 1; });
