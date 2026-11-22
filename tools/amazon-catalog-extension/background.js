import { asinFromUrl, readAmazonProduct } from './amazon.js';
import { catalogLookup, catalogOwnerPreference, catalogRegister, updateCatalogPrice, validateAsin } from './catalog.js';
import { lookupKeepa } from './keepa.js';

const storage = chrome.storage.local;
const restrictedStorage = storage.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
const updateAlarm = 'local-build-update';
const amazonPages = ['https://www.amazon.co.jp/*', 'https://amazon.co.jp/*'];
let keepaQueue = Promise.resolve();
let pendingRequests = 0;

async function checkLocalUpdate() {
  const response = await fetch(chrome.runtime.getURL('manifest.json'), { cache: 'no-store' });
  if (!response.ok) return;
  const { version } = await response.json();
  const current = chrome.runtime.getManifest().version;
  if (pendingRequests === 0 && typeof version === 'string' && version !== current && /^\d+(\.\d+){0,3}$/.test(version)) {
    chrome.runtime.reload();
  }
}

async function scheduleLocalUpdate() {
  if (!(await chrome.alarms.get(updateAlarm))) {
    await chrome.alarms.create(updateAlarm, { periodInMinutes: 1 });
  }
  await checkLocalUpdate();
}

async function restoreAmazonPanels() {
  const tabs = await chrome.tabs.query({ url: amazonPages });
  await Promise.allSettled(tabs.filter(tab => tab.id != null && asinFromUrl(tab.url)).map(tab =>
    chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] })));
}

chrome.runtime.onStartup.addListener(() => void scheduleLocalUpdate().catch(console.error));
chrome.runtime.onInstalled.addListener(({ reason }) => {
  void scheduleLocalUpdate().catch(console.error);
  if (reason === 'update') void restoreAmazonPanels().catch(console.error);
});
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === updateAlarm) void checkLocalUpdate().catch(console.error);
});

function serializeKeepa(run) {
  const result = keepaQueue.then(run);
  keepaQueue = result.catch(() => {});
  return result;
}

async function amazonProduct(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const asin = asinFromUrl(tab.url);
  if (!asin) throw new Error('Amazon.co.jpの商品ページで拡張機能を開いてください。');
  const [entry] = await chrome.scripting.executeScript({
    target: { tabId }, func: readAmazonProduct, args: [asin],
  });
  if (!entry?.result) throw new Error('Amazonの商品情報を読み取れませんでした。ページを更新してください。');
  validateAsin(entry.result.asin);
  return entry.result;
}

async function verifySelection(tabId, asin) {
  const current = await amazonProduct(tabId);
  if (current.asin !== asin) throw new Error('選択中の商品が変わりました。拡張機能を開き直してください。');
  return current;
}

async function handle(message, sender) {
  await restrictedStorage;
  if (sender.url === chrome.runtime.getURL('options.html')) {
    if (message.type === 'settings') {
      return { configured: Boolean((await storage.get('keepaKey')).keepaKey) };
    }
    if (message.type === 'set-key') {
      return serializeKeepa(async () => {
        const key = String(message.key ?? '').trim();
        if (key && !/^[A-Za-z0-9_-]{20,128}$/.test(key)) throw new Error('KeepaのAPIキーを確認してください。');
        if (key) await storage.set({ keepaKey: key });
        else await storage.remove('keepaKey');
        await storage.remove('keepaQuota');
        return { configured: Boolean(key) };
      });
    }
  }
  const popup = sender.url === chrome.runtime.getURL('popup.html');
  const panel = sender.id === chrome.runtime.id && sender.frameId === 0 && Boolean(asinFromUrl(sender.url));
  if (popup && ['owner-options', 'set-owner'].includes(message.type)) {
    const { catalogOwner } = await storage.get('catalogOwner');
    const selected = await catalogOwnerPreference(catalogOwner, message.type === 'set-owner' ? message.ownerId : undefined);
    if (message.type === 'set-owner') {
      await storage.set({ catalogOwner: { userId: selected.userId, ownerId: selected.ownerId } });
      const tabs = await chrome.tabs.query({ url: amazonPages });
      await Promise.allSettled(tabs.filter(tab => tab.id != null).map(tab =>
        chrome.tabs.sendMessage(tab.id, { type: 'catalog-owner-changed' })));
    }
    return selected;
  }
  if (!panel) throw new Error('Amazonの商品ページで実行してください。');
  if (message.type === 'panel-layout') return storage.get(['panelSide', 'panelPosition']);
  if (message.type === 'set-panel-position' && Number.isFinite(message.position?.x) && Number.isFinite(message.position?.y)) {
    const { x, y } = message.position;
    await storage.set({ panelPosition: { x, y } });
    return;
  }
  if (message.type === 'open-options') return chrome.runtime.openOptionsPage();
  const tabId = sender.tab?.id;
  if (message.type === 'read-page') return amazonProduct(tabId);
  if (message.type === 'catalog-lookup') {
    const current = await verifySelection(tabId, message.asin);
    return catalogLookup(message.asin, (await storage.get('catalogOwner')).catalogOwner, current.maker);
  }
  if (message.type === 'keepa-lookup') {
    await verifySelection(tabId, message.asin);
    return serializeKeepa(() => lookupKeepa(message.asin, storage));
  }
  if (message.type === 'catalog-register') {
    await verifySelection(tabId, message.asin);
    return catalogRegister(message.asin, message.product, message.userId, message.ownerId,
      (await storage.get('catalogOwner')).catalogOwner);
  }
  if (message.type === 'catalog-update-price') {
    await verifySelection(tabId, message.asin);
    return updateCatalogPrice(message.asin, message);
  }
  throw new Error('操作を確認できませんでした。');
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  pendingRequests++;
  handle(message, sender).then(
    data => reply({ ok: true, data }),
    error => reply({ ok: false, code: error.code, message: error.message || '処理できませんでした。' }),
  ).finally(() => { pendingRequests--; });
  return true;
});


