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
}
(async () => {
  await verify('https://test-repo-delivery.vercel.app/', false);
  await verify('https://test-repo-delivery.vercel.app/', true);
  await verify('https://kazuki101213.github.io/test-repo/delivery/', false);
  console.log('Service worker push display, closed/open app navigation, Pages base and destination validation passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
