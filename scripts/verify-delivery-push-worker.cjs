const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const {createRequire}=require('node:module');
const appRequire=createRequire(path.join(__dirname,'../apps/admin/package.json'));
const esbuild=createRequire(appRequire.resolve('vite/package.json'))('esbuild');
const validationSource=fs.readFileSync(path.join(__dirname,'../supabase/functions/delivery-push/validation.ts'),'utf8');
const validationModule={exports:{}};vm.runInNewContext(esbuild.transformSync(validationSource,{loader:'ts',format:'cjs'}).code,{module:validationModule,exports:validationModule.exports,URL});
const approvalPayload=validationModule.exports.notificationPayload({app_kind:'delivery',kind:'photo',lot_seq:2198,item_id:'61892662-9437-4d89-8926-348ed017e954'});
assert.equal(approvalPayload.body,'【2198】出品お願いします。');assert.equal(approvalPayload.tag,'delivery-61892662-9437-4d89-8926-348ed017e954-photo');
const shippingPayload=validationModule.exports.notificationPayload({app_kind:'delivery',kind:'shipping',lot_seq:2390,item_id:'shipping-item'});assert.equal(shippingPayload.body,'【2390】発送お願いします。');assert.equal(shippingPayload.itemId,'shipping-item');assert.equal(shippingPayload.tag,'delivery-shipping-item-shipping');
const switchSource = fs.readFileSync(path.join(__dirname, '../packages/shared/src/applicationSwitch.ts'), 'utf8');
const switchModule = { exports: {} };
vm.runInNewContext(esbuild.transformSync(switchSource, { loader: 'ts', format: 'cjs' }).code,
  { module: switchModule, exports: switchModule.exports, URLSearchParams });
const source = fs.readFileSync(path.join(__dirname, '../apps/delivery/public/sw.js'), 'utf8');
async function verify(scope, useExisting) {
  const handlers = {}, notifications = [], opened = [], navigated = [];
  const existing = { url: scope, navigate: async url => { navigated.push(url); }, focus: async () => {} };
  const self = { registration: { scope, showNotification: async (title, options) => notifications.push({ title, options }) },
    skipWaiting() {}, addEventListener: (kind, handler) => { handlers[kind] = handler; },
    clients: { claim: async () => {}, matchAll: async () => useExisting ? [existing] : [], openWindow: async url => opened.push(url) } };
  vm.runInNewContext(source, { self, URL });
  let waiting;
  const itemId = '61892662-9437-4d89-8926-348ed017e954';
  handlers.push({ data: { json: () => (approvalPayload) }, waitUntil: promise => { waiting = promise; } });
  await waiting;
  assert.equal(notifications[0].options.body, '【2198】出品お願いします。');
  handlers.notificationclick({ notification: { data: { itemId }, close() {} }, waitUntil: promise => { waiting = promise; } });
  await waiting;
  assert.equal((useExisting ? navigated : opened)[0], `${scope}?itemId=${itemId}`);
  // Push data cannot change the notification click destination to another site.
  handlers.notificationclick({ notification: { data: { itemId: 'https://invalid.example/' }, close() {} }, waitUntil: promise => { waiting = promise; } });
  await waiting;
  assert.equal((useExisting ? navigated : opened)[1], scope);

  const packingPayload = validationModule.exports.notificationPayload({ app_kind: 'admin', kind: 'packing_photo', lot_seq: 2450, item_id: itemId });
  handlers.push({ data: { json: () => packingPayload }, waitUntil: promise => { waiting = promise; } });
  await waiting;
  const packing = notifications.at(-1);
  assert.equal(packing.title, '管理アプリ');
  assert.equal(packing.options.body, '【2450】梱包が追加されました。');
  handlers.notificationclick({ notification: { data: packing.options.data, close() {} }, waitUntil: promise => { waiting = promise; } });
  await waiting;
  const target = new URL((useExisting ? navigated : opened).at(-1));
  assert.equal(target.href, `${scope}?taskKind=packing_photo&itemId=${itemId}`);
  assert.equal(switchModule.exports.initialApplication(target.search, target.hash, 'delivery'), 'management');
}
(async () => {
  await verify('https://test-repo-delivery.vercel.app/', false);
  await verify('https://test-repo-delivery.vercel.app/', true);
  await verify('https://bussan-delivery.vercel.app/', false);
  await verify('https://bussan-delivery.vercel.app/', true);
  await verify('https://kazuki101213.github.io/test-repo/delivery/', false);
  console.log('Service worker push display, closed/open app navigation, Pages base and destination validation passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
