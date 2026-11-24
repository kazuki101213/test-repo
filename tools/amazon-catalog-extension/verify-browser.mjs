import assert from 'node:assert/strict';
import { appendFile, cp, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [build, playwright] = process.argv.slice(2);
const { chromium } = await import(pathToFileURL(resolve(playwright)).href);
const fixtureDir = await mkdtemp(join(tmpdir(), 'amazon-catalog-check-'));
const extension = join(fixtureDir, 'extension');
const asin = 'B07216NYPP';
const other = 'B012345678';
const adminOrigin = 'https://test-repo-delivery.vercel.app';
const appAliases = ['https://bussan-admin.vercel.app', 'https://bussan-delivery.vercel.app'];
const amazonOrigin = 'https://www.amazon.co.jp';
const sessionStorageKey = 'sb-xgoppuqoqeppckyunnvx-auth-token';
let context;

try {
  await cp(resolve(build), extension, { recursive: true });
  const manifestPath = join(extension, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const legacy = { ...manifest, version: '0.1.0' };
  delete legacy.content_scripts;
  legacy.host_permissions = manifest.host_permissions.filter(host => !host.includes('amazon.co.jp'));
  await writeFile(manifestPath, JSON.stringify(legacy));
  context = await chromium.launchPersistentContext(join(fixtureDir, 'profile'), {
    channel: 'chromium', headless: true,
    ...(process.env.CATALOG_CHROME_PATH ? { executablePath: process.env.CATALOG_CHROME_PATH } : {}),
    args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension],
  });
  const oldWorker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const base = oldWorker.url().replace(/\/background\.js$/, '');
  const oldPopup = await context.newPage();
  await oldPopup.goto(base + '/popup.html');
  const update = oldPopup.getByRole('button', { name: '拡張機能の更新画面を開く' });
  await update.waitFor({ timeout: 8000 });
  await writeFile(manifestPath, JSON.stringify(manifest));
  const managerReady = context.waitForEvent('page', { timeout: 8000 });
  await update.click({ timeout: 8000 });
  const manager = await managerReady;
  await manager.waitForURL('chrome://extensions/');
  const developerMode = manager.locator('#devMode');
  if (await developerMode.getAttribute('aria-pressed') !== 'true') await developerMode.click();
  const reload = manager.locator('extensions-item').filter({ hasText: manifest.name }).locator('#dev-reload-button');
  await reload.click({ timeout: 8000 });
  const updatedPopup = await context.newPage();
  for (let attempt = 0; ; attempt++) {
    try {
      await updatedPopup.goto(base + '/popup.html', { timeout: 3000 });
      break;
    } catch (error) {
      if (attempt === 10) {
        const manager = await context.newPage();
        await manager.goto('chrome://extensions/');
        throw new Error((await manager.locator('extensions-item').allTextContents()).join(' ').trim().replace(/\s+/g, ' ') || error.message);
      }
      await new Promise(resolve => setTimeout(resolve, 300));
    }
  }
  await updatedPopup.waitForFunction(version => globalThis.chrome?.runtime?.getManifest().version === version, manifest.version, { timeout: 8000 });
  await updatedPopup.evaluate(() => chrome.runtime.sendMessage({ type: 'test-wake-worker' }).catch(() => {}));
  const worker = context.serviceWorkers().at(-1) ?? await context.waitForEvent('serviceworker', { timeout: 8000 });
  assert.equal(await worker.evaluate(() => chrome.runtime.getManifest().version), manifest.version);
  await context.addInitScript(({ origin, key }) => {
    if (location.origin !== origin) return;
    const saved = JSON.parse(localStorage.getItem(key));
    if (saved?.expires_at * 1000 < Date.now()) {
      localStorage.setItem(key, JSON.stringify({ ...saved, expires_at: Math.floor(Date.now() / 1000) + 3600 }));
    }
  }, { origin: adminOrigin, key: sessionStorageKey });
  await context.route(adminOrigin + '/**', route => route.fulfill({
    contentType: 'text/html; charset=utf-8',
    body: '<title>管理アプリのテスト</title>',
  }));
  for (const origin of appAliases) {
    await context.route(origin + '/**', route => route.fulfill({
      contentType: 'text/html; charset=utf-8', body: '<title>別の管理アプリ入口</title>',
    }));
  }
  await context.route(amazonOrigin + '/**', route => route.fulfill({
    contentType: 'text/html; charset=utf-8',
    headers: { 'Content-Security-Policy': "script-src 'none'; require-trusted-types-for 'script'" },
    body: '<title>Amazonの商品</title><h1 id="productTitle">ソニー 有線イヤホン MDR-EX155</h1>'
      + '<input id="ASIN" value=""><div id="productDetails_expanderSectionTables"><div><table>'
      + '<tr><th>型番</th><td>MDR-EX155 B</td></tr><tr><th>メーカー</th><td>Sony</td></tr></table></div></div>'
      + '<table id="productDetails_techSpec_section_1"></table>'
      + '<div id="corePriceDisplay_desktop_feature_div">'
      + '<span class="a-price a-text-price"><span class="a-offscreen">￥22,000</span></span>'
      + '<span class="a-price priceToPay"><span class="a-offscreen">￥18,900</span></span></div>'
      + '<div id="wayfinding-breadcrumbs_feature_div"><a>家電＆カメラ</a></div>'
      + '<div id="socialProofingAsinFaceout_feature_div">過去1か月で4000点以上購入されました<script type="application/json">{"internalFixture":true}</script></div>',
  }));
  const admin = await context.newPage();
  await admin.goto(adminOrigin);
  await admin.evaluate(key => localStorage.setItem(key, JSON.stringify({
    user: { id: 'admin-fixture' }, access_token: 'fixture', expires_at: Math.floor(Date.now() / 1000) + 3600,
  })), sessionStorageKey);


  await worker.evaluate(({ asin, other }) => {
    const realFetch = globalThis.fetch.bind(globalThis);
    globalThis.testLog = { keepa: 0, saves: 0, feeRequests: 0, request: null, row: null };
    globalThis.fetch = async (input, options) => {
      const url = new URL(input);
      if (url.hostname === 'api.keepa.com') {
        testLog.keepa++;
        if (testLog.keepa === 1) return Response.json({
          tokensLeft: 1, refillIn: 60_000, refillRate: 1,
          products: [{ asin, domainId: 5, monthlySold: 4000, packageLength: 175, packageWidth: 85,
            packageHeight: 25, packageWeight: 55, stats: { salesRankDrops30: 41, salesRankDrops90: 145, avg30: [-1, 1325, 2052] } }],
        });
        return Response.json({ tokensLeft: 0, refillIn: 60_000, refillRate: 1 }, { status: 429 });
      }
      if (url.hostname === 'xgoppuqoqeppckyunnvx.supabase.co') {
        if (url.pathname === '/functions/v1/amazon-catalog-estimate') {
          const body = JSON.parse(options.body);
          testLog.feeRequests++;
          const payouts = { 20000: 16500, 18500: 15000, 18900: 15300 };
          if (body.asin !== other || !payouts[body.price]) return Response.json({ error: 'unexpected estimate' }, { status: 400 });
          return Response.json({ payout: payouts[body.price] });
        }
        if (options.headers.Authorization !== 'Bearer fixture') return Response.json({}, { status: 401 });
        if (url.pathname.endsWith('/staff')) return Response.json([
          { id: 'owner-one', code: 'AA', name: '管理者A', display_name: null },
          { id: 'owner-two', code: 'ZZ', name: '管理者B', display_name: null },
        ]);
        if (url.pathname.endsWith('/profiles')) return Response.json([{ staff_id: 'owner-one' }]);
        if (options.method === 'POST') {
          testLog.saves++;
          testLog.request = JSON.parse(options.body);
          testLog.row = {
            ...testLog.request, product_no: 999, id: '12345678-1234-1234-1234-123456789abc', is_active: true,
            owner_staff_id: testLog.request.owner_staff_id ?? 'owner-one',
          };
          return Response.json([testLog.row], { status: 201 });
        }
        if (options.method === 'PATCH') {
          const row = testLog.row;
          if (url.searchParams.get('id') !== 'eq.' + row.id ||
            url.searchParams.get('asin') !== 'eq.' + row.asin ||
            url.searchParams.get('is_active') !== 'eq.true' ||
            url.searchParams.get('list_price') !== 'eq.' + row.list_price) return Response.json([]);
          testLog.pricePatch = JSON.parse(options.body);
          Object.assign(row, testLog.pricePatch);
          return Response.json([row]);
        }
        if (testLog.row && url.searchParams.get('asin') === 'eq.' + testLog.row.asin) return Response.json([testLog.row]);
        return Response.json([]);
      }
      return realFetch(input, options);
    };
  }, { asin, other });
  const amazon = await context.newPage();
  amazon.on('pageerror', error => console.error(error.message));
  amazon.on('console', message => { if (message.type() === 'error') console.error(message.text().slice(0, 200)); });
  await worker.evaluate(() => chrome.storage.local.set({ panelClosed: true }));
  await amazon.goto(amazonOrigin + '/dp/' + asin);

  const settings = await context.newPage();
  await settings.goto(base + '/options.html');
  await settings.getByText('Keepa APIキーは未設定です。').waitFor();
  await settings.locator('#key').fill('fixture-key-only-for-tests');
  await settings.getByRole('button', { name: '保存' }).click();
  await settings.getByText('Keepa APIキーは設定済みです。').waitFor();

  async function popup() {
    const page = await context.newPage();
    await page.goto(base + '/popup.html');
    return page;
  }


  const host = amazon.locator('#bussan-amazon-catalog-panel');
  await host.waitFor({ state: 'attached', timeout: 7000 });
  console.log('Panel box', await host.boundingBox());
  const panelBox = await host.boundingBox();
  const dimensions = await amazon.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  assert.equal(Math.round(dimensions.width - panelBox.x - panelBox.width), 16);
  assert.ok(Math.abs(panelBox.y + panelBox.height / 2 - dimensions.height / 2) < 2);
  const cdp = await context.newCDPSession(amazon);
  async function panelNode(selector) {
    const { root } = await cdp.send('DOM.getDocument', { depth: 0 });
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#bussan-amazon-catalog-panel' });
    const { node } = await cdp.send('DOM.describeNode', { nodeId, pierce: true });
    assert.equal(node.shadowRoots[0].shadowRootType, 'closed');
    const { nodeId: shadowNodeId } = await cdp.send('DOM.pushNodesByBackendIdsToFrontend', { backendNodeIds: [node.shadowRoots[0].backendNodeId] })
      .then(({ nodeIds }) => ({ nodeId: nodeIds[0] }));
    return (await cdp.send('DOM.querySelector', { nodeId: shadowNodeId, selector })).nodeId;
  }
  async function panelMarkup(selector) {
    return (await cdp.send('DOM.getOuterHTML', { nodeId: await panelNode(selector) })).outerHTML;
  }
  async function clickPanel(selector) {
    await amazon.bringToFront();
    const nodeId = await panelNode(selector);
    await cdp.send('DOM.scrollIntoViewIfNeeded', { nodeId });
    const { model } = await cdp.send('DOM.getBoxModel', { nodeId });
    await amazon.mouse.click((model.border[0] + model.border[4]) / 2, (model.border[1] + model.border[5]) / 2);
  }
  async function panelValue(selector) {
    const { object } = await cdp.send('DOM.resolveNode', { nodeId: await panelNode(selector) });
    return (await cdp.send('Runtime.callFunctionOn', {
      objectId: object.objectId, functionDeclaration: 'function () { return this.value; }', returnByValue: true,
    })).result.value;
  }
  await amazon.waitForFunction(() => document.querySelector('#bussan-amazon-catalog-panel')?.getBoundingClientRect().height > 120, null, { timeout: 6000 })
    .catch(async () => { throw new Error(await panelMarkup('main')); });
  assert.match(await panelMarkup('#amazon-purchases'), /過去1か月で4000点以上購入されました/);
  assert.doesNotMatch(await panelMarkup('#amazon-purchases'), /internalFixture/);
  await waitPanel('#catalog-status', /未登録/);
  assert.match(await panelMarkup('#catalog-status'), /data-registration="unregistered"/);
  assert.equal(await panelNode('#catalog-owner'), 0);
  assert.match(await panelMarkup('#model-display'), />MDR-EX155 B</);
  assert.equal(await panelValue('[name="model_no"]'), 'MDR-EX155 B');
  assert.match(await panelMarkup('#asin'), />B07216NYPP</);
  assert.match(await panelMarkup('#product'), /id="model-display"[^]*id="asin"/);
  assert.doesNotMatch(await panelMarkup('main'), /ソニー 有線イヤホン|折りたたむ|panel-toggle/);
  assert.equal(await panelValue('[name="shipping_category"]'), '小');
  assert.equal(await panelNode('[name="shipping_size"]'), 0);
  assert.equal(await worker.evaluate(() => testLog.keepa), 0);
  assert.doesNotMatch(await panelMarkup('main'), /左へ移動|右へ移動|panel-move/);
  await clickPanel('#panel-close');
  assert.match(await panelMarkup('main'), /^<main[^>]*hidden/);
  assert.doesNotMatch(await panelMarkup('#panel-show'), /^<button[^>]*hidden/);
  await clickPanel('#panel-show');
  assert.doesNotMatch(await panelMarkup('main'), /^<main[^>]*hidden/);
  assert.equal(await panelValue('[name="model_no"]'), 'MDR-EX155 B');
  const beforeDrag = await host.boundingBox();
  const { model: handle } = await cdp.send('DOM.getBoxModel', { nodeId: await panelNode('header h1') });
  await amazon.mouse.move(handle.border[0] + 10, handle.border[1] + 8);
  await amazon.mouse.down();
  await amazon.mouse.move(handle.border[0] - 170, handle.border[1] - 52, { steps: 6 });
  await amazon.mouse.up();
  const moved = await host.boundingBox();
  assert.ok(Math.abs(moved.x - (beforeDrag.x - 180)) < 2);
  assert.ok(Math.abs(moved.y - (beforeDrag.y - 60)) < 2);
  await clickPanel('#panel-close');
  assert.match(await panelMarkup('main'), /^<main[^>]*hidden/);
  await amazon.reload();
  await host.waitFor();
  assert.doesNotMatch(await panelMarkup('main'), /^<main[^>]*hidden/);
  const restored = await host.boundingBox();
  assert.ok(Math.abs(restored.x - moved.x) < 2 && Math.abs(restored.y - moved.y) < 2);
  await waitPanel('#catalog-status', /未登録/);
  await amazon.setViewportSize({ width: 650, height: 460 });
  await amazon.waitForFunction(() => {
    const box = document.querySelector('#bussan-amazon-catalog-panel').getBoundingClientRect();
    return box.right <= document.documentElement.clientWidth + 1 && box.bottom <= document.documentElement.clientHeight + 1;
  });
  const bodyNode = await panelNode('#catalog-panel-body');
  const { object: scrollBody } = await cdp.send('DOM.resolveNode', { nodeId: bodyNode });
  const readScrollBody = async expression => (await cdp.send('Runtime.callFunctionOn', {
    objectId: scrollBody.objectId, functionDeclaration: expression, returnByValue: true, awaitPromise: true,
  })).result.value;
  assert.equal(await readScrollBody('function () { return getComputedStyle(this).scrollbarWidth; }'), 'none');
  assert.ok(await readScrollBody('function () { return this.scrollHeight > this.clientHeight; }'));
  const { model: bodyBox } = await cdp.send('DOM.getBoxModel', { nodeId: bodyNode });
  await amazon.mouse.move(bodyBox.border[0] + 12, bodyBox.border[1] + 12);
  await amazon.mouse.wheel(0, 250);
  assert.ok(await readScrollBody(`function () {
    return new Promise(resolve => {
      const deadline = performance.now() + 1500;
      const check = () => {
        if (this.scrollTop > 0 || performance.now() >= deadline) resolve(this.scrollTop > 0);
        else requestAnimationFrame(check);
      };
      check();
    });
  }`));

  async function waitPanel(selector, pattern, attempts = 60) {
    for (let attempt = 0; attempt < attempts; attempt++) {
      const markup = await panelMarkup(selector);
      if (pattern.test(markup)) return markup;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.match(await panelMarkup(selector), pattern);
  }
  const first = await popup();
  await first.locator('#catalog-owner option').nth(1).waitFor({ state: 'attached' });
  assert.equal(await first.locator('#catalog-owner').inputValue(), 'owner-one');
  assert.equal(await first.locator('#registration, #keepa, #catalog-status').count(), 0);
  await first.locator('#catalog-owner').selectOption('owner-two');
  await first.getByText('登録先を変更しました。').waitFor();
  const again = await popup();
  await again.locator('#catalog-owner option').nth(1).waitFor({ state: 'attached' });
  assert.equal(await again.locator('#catalog-owner').inputValue(), 'owner-two');

  await clickPanel('#keepa');
  await waitPanel('#keepa-metrics', /41回 \/ 145回/);
  assert.equal(await panelNode('[name="shipping_size"]'), 0);
  const { object: turnover } = await cdp.send('DOM.resolveNode', { nodeId: await panelNode('[name="turnover"]') });
  const turnoverValue = async () => (await cdp.send('Runtime.callFunctionOn', {
    objectId: turnover.objectId, functionDeclaration: 'function () { return this.value; }', returnByValue: true,
  })).result.value;
  assert.equal(await turnoverValue(), '高');
  await cdp.send('Runtime.callFunctionOn', {
    objectId: turnover.objectId, functionDeclaration: 'function () { this.value = "中"; }',
  });
  await clickPanel('#keepa');
  await waitPanel('#keepa-status', /トークン消費なし/);
  assert.equal(await turnoverValue(), '中');
  assert.equal(await worker.evaluate(() => testLog.keepa), 1);

  await clickPanel('#panel-close');
  await amazon.locator('#ASIN').evaluate((element, value) => {
    element.value = value;
    const row = document.querySelector('#productDetails_techSpec_section_1').insertRow();
    row.insertCell().textContent = '梱包サイズ';
    row.insertCell().textContent = '32 × 22 × 5 cm; 3 kg';
  }, other);
  await waitPanel('#asin', new RegExp(other));
  assert.doesNotMatch(await panelMarkup('main'), /^<main[^>]*hidden/);
  await waitPanel('#catalog-status', /未登録/);
  assert.equal(await panelNode('[name="shipping_size"]'), 0);
  await clickPanel('#keepa');
  await waitPanel('#keepa-status', /トークンの回復待ち/);
  assert.match(await panelMarkup('#keepa'), /disabled/);
  await clickPanel('#registration [name="list_price"]');
  await amazon.keyboard.type('20000');
  assert.equal(await panelNode('#estimate'), 0);
  assert.equal(await worker.evaluate(() => testLog.feeRequests), 0);
  await clickPanel('#register');
  await waitPanel('#catalog-status', /登録済み/);
  await waitPanel('#catalog-number', /品番 999/);
  const actual = await worker.evaluate(() => testLog);
  assert.equal(actual.keepa, 2);
  assert.equal(actual.saves, 1);
  assert.equal(actual.request.asin, other);
  assert.equal(actual.request.owner_staff_id, 'owner-two');
  assert.equal(actual.request.shipping_category, '小');
  assert.equal(actual.request.shipping_size, '80');
  assert.equal(actual.feeRequests, 1);
  assert.equal(actual.request.payout_estimate, 16500);
  assert.equal(actual.request.target_cost, 13200);
  const registeredPrice = '#catalog-price-form [name="list_price"]';
  assert.match(await panelMarkup(registeredPrice), /Amazonの表示価格 18,900円/);
  assert.match(await panelMarkup('#save-catalog-price'), />保存<\/button>/);
  assert.equal(await panelNode('#use-amazon-price'), 0);
  const { model: modelBox } = await cdp.send('DOM.getBoxModel', { nodeId: await panelNode('#model-display') });
  const { model: priceBox } = await cdp.send('DOM.getBoxModel', { nodeId: await panelNode(registeredPrice) });
  assert.equal(await panelNode('#check'), 0);
  assert.ok(priceBox.border[0] > modelBox.border[2]);
  assert.ok(priceBox.border[1] < modelBox.border[5] && priceBox.border[5] > modelBox.border[1]);
  assert.equal(await panelValue(registeredPrice), '20000');
  await clickPanel(registeredPrice);
  await amazon.keyboard.press('Control+a');
  await amazon.keyboard.type('18500');
  await clickPanel('#save-catalog-price');
  await waitPanel('#catalog-price-status', /販売想定金額を保存しました/);
  // 価格を変えたらAmazonの手数料APIで振込想定・仕入れ目標も計算し直す（15,000円以下は75%）。
  assert.deepEqual(await worker.evaluate(() => testLog.pricePatch), { list_price: 18500, payout_estimate: 15000, target_cost: 12000 });
  assert.equal(await worker.evaluate(() => testLog.feeRequests), 2);
  assert.equal(await panelValue(registeredPrice), '18500');
  await worker.evaluate(() => { testLog.row.list_price = 20001; });
  await clickPanel(registeredPrice);
  await amazon.keyboard.press('Control+a');
  await amazon.keyboard.type('18900');
  await clickPanel('#save-catalog-price');
  await waitPanel('#catalog-price-status', /商品リストが変更されたか、編集権限がありません/);
  assert.equal(await worker.evaluate(() => testLog.row.list_price), 20001);
  await amazon.evaluate(() => window.dispatchEvent(new Event('focus')));
  await waitPanel('#catalog-status', /登録済み/);
  assert.equal(await panelValue(registeredPrice), '20001');
  await worker.evaluate(() => { testLog.row.list_price = null; });
  await amazon.evaluate(() => window.dispatchEvent(new Event('focus')));
  await waitPanel('#catalog-status', /登録済み/);
  assert.equal(await panelValue(registeredPrice), '18900');

  await again.locator('#catalog-owner').selectOption('owner-one');
  await again.getByText('登録先を変更しました。').waitFor();
  await waitPanel('#catalog-message', /管理者Bの商品リストに登録されています/);
  await waitPanel('#catalog-number', /品番 999/);
  assert.match(await panelMarkup('#registration'), /^<form[^>]*hidden/);
  assert.equal(await worker.evaluate(() => testLog.saves), 1);

  await amazon.goto(amazonOrigin + '/s?k=fixture');
  await host.waitFor({ state: 'detached' });
  await admin.evaluate(key => {
    const saved = JSON.parse(localStorage.getItem(key));
    localStorage.setItem(key, JSON.stringify({ ...saved, expires_at: 1 }));
  }, sessionStorageKey);
  await admin.close();
  await amazon.goto(amazonOrigin + '/dp/' + asin);
  await amazon.bringToFront();
  await host.waitFor();
  await waitPanel('#catalog-status', /未登録/, 130);
  assert.equal(context.pages().filter(page => [adminOrigin, ...appAliases].some(origin =>
    page.url().startsWith(origin + '/'))).length, 0);
  assert.equal(await amazon.evaluate(() => document.visibilityState), 'visible');
  const signedOut = await context.newPage();
  await signedOut.goto(adminOrigin);
  await signedOut.evaluate(key => localStorage.removeItem(key), sessionStorageKey);
  await signedOut.close();
  await amazon.evaluate(() => window.dispatchEvent(new Event('focus')));
  await waitPanel('#catalog-message', /ログインが必要です/, 130);
  assert.doesNotMatch(await panelMarkup('#catalog-login'), / hidden/);
  const signedIn = await context.newPage();
  await signedIn.goto(adminOrigin);
  await signedIn.bringToFront();
  await signedIn.evaluate(key => localStorage.setItem(key, JSON.stringify({
    user: { id: 'admin-fixture' }, access_token: 'fixture', expires_at: Math.floor(Date.now() / 1000) + 3600,
  })), sessionStorageKey);
  await amazon.bringToFront();
  await amazon.evaluate(() => window.dispatchEvent(new Event('focus')));
  await waitPanel('#catalog-status', /未登録/);
  assert.match(await panelMarkup('#catalog-login'), / hidden/);
  await signedIn.close();
  const nextVersion = manifest.version.replace(/\d+$/, part => String(Number(part) + 1));
  await appendFile(join(extension, 'content.js'), '\ndocument.documentElement.dataset.testBuild = "updated";\n');
  const pending = manifestPath + '.pending';
  await writeFile(pending, JSON.stringify({ ...manifest, version: nextVersion }));
  await rename(pending, manifestPath);
  await worker.evaluate(() => chrome.alarms.create('local-build-update', { delayInMinutes: 0.05 }));
  await amazon.waitForFunction(() => document.documentElement.dataset.testBuild === 'updated', null, { timeout: 12000 });
  await host.waitFor();
  const updatedSettings = await context.newPage();
  await updatedSettings.goto(base + '/options.html');
  assert.equal(await updatedSettings.evaluate(() => chrome.runtime.getManifest().version), nextVersion);
  await updatedSettings.getByText('Keepa APIキーは設定済みです。').waitFor();
  console.log('Local version update applied automatically, existing Amazon tab reinjected, and settings retained.');
  console.log('Chrome extension: old-version update, model input, panel position and visibility, owner selection, registration, duplicate protection and Keepa cache verified.');
} finally {
  await context?.close();
  await rm(fixtureDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
}





