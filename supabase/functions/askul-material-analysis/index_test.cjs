const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

function fixture({ admin = true, auth = true, output = { summary: '購入数が増えています。', notes: [{ row: 1, reason: '過去平均の2倍です。' }] } } = {}) {
  const sent = [];
  const source = fs.readFileSync(__dirname + '/index.ts', 'utf8')
    .replace(/^import .+\n/, '').replace('if (import.meta.main) Deno.serve(handler);', '');
  const context = {
    exports: {}, Response, Request, AbortSignal,
    Deno: { env: { get: () => 'gemini-fixture' } },
    createClient: () => ({
      auth: { getUser: async () => ({ data: { user: auth ? { id: 'fixture' } : null }, error: null }) },
      rpc: async () => ({ data: admin, error: null }),
    }),
    fetch: async (_, request) => {
      sent.push(JSON.parse(request.body));
      return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(output) }] } }] });
    },
  };
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText, context);
  const call = (extra = {}, authorization = 'Bearer fixture', bubbleWrap) => context.exports.handler(new Request('https://fixture.invalid', {
    method: 'POST', headers: { authorization }, body: JSON.stringify({ rows: [{
      row: 1, quantity: 8, amount: 1600, averageQuantity: 4, comparisonMonths: 2, increased: true, ...extra,
    }], bubbleWrap }),
  }));
  return { sent, call };
}

test('requires an authenticated administrator and rejects inconsistent comparisons before sending data', async () => {
  for (const options of [{ admin: false }, { auth: false }]) {
    const { sent, call } = fixture(options);
    assert([401, 403].includes((await call()).status));
    assert.equal(sent.length, 0);
  }
  const { sent, call } = fixture();
  assert.equal((await call({ averageQuantity: null })).status, 400);
  assert.equal(sent.length, 0);
});

test('sends only allowlisted aggregates and checks output row references', async () => {
  const { sent, call } = fixture();
  assert.equal((await call({ address: 'private-address', staffName: 'private-staff', item: 'private-item' })).status, 200);
  assert.deepEqual(JSON.parse(sent[0].contents[0].parts[0].text), {purchases:[{
    row: 1, quantity: 8, amount: 1600, averageQuantity: 4, comparisonMonths: 2, increased: true,
  }], bubbleWrap:[]});
  assert(!JSON.stringify(sent).includes('private-'));
  const invalid = fixture({ output: { summary: '結果', notes: [{ row: 2, reason: '範囲外' }] } });
  assert.equal((await invalid.call()).status, 502);
});

test('checks the per-item calculation and forwards anonymous workload and length totals', async () => {
  const { sent, call } = fixture();
  const workload = { completedItems: 4, quantityPerItem: 2, peerQuantityPerItem: 1, peerCount: 1, abovePeers: true };
  const wrap = { recorderItems: 3, estimatedMetres: 12, purchasedMetres: 42 };
  assert.equal((await call({ ...workload, quantityPerItem: 3 })).status, 400);
  assert.equal((await call(workload, 'Bearer fixture', [{ ...wrap, estimatedMetres: 20 }])).status, 400);
  assert.equal(sent.length, 0);
  assert.equal((await call(workload, 'Bearer fixture', [{ ...wrap, staffName: 'private-staff' }])).status, 200);
  const input = JSON.parse(sent[0].contents[0].parts[0].text);
  assert.equal(input.purchases[0].abovePeers, true);
  assert.deepEqual(input.bubbleWrap, [wrap]);
});
