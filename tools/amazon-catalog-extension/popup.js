import { buildVersion } from './build-version.js';

const status = document.querySelector('#owner-status');
const select = document.querySelector('#catalog-owner');

if (chrome.runtime.getManifest().version !== buildVersion) {
  document.querySelector('#owner-picker').hidden = true;
  status.textContent = '拡張機能の更新画面で「Amazon 商品リスト登録」の ↻ を押し、Amazonの商品ページを再読み込みしてください。';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'primary';
  button.textContent = '拡張機能の更新画面を開く';
  button.addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions/' }));
  document.querySelector('main').append(button);
} else {
  let confirmed = '';
  async function selectOwner(type, ownerId) {
    select.disabled = true;
    try {
      const reply = await chrome.runtime.sendMessage({ type, ownerId });
      if (!reply?.ok) throw new Error(reply?.message || '管理者を読み込めませんでした。');
      const { owners, ownerId: selected } = reply.data;
      select.replaceChildren(...owners.map(owner => new Option(owner.display_name || owner.name, owner.id)));
      confirmed = selected;
      status.textContent = type === 'set-owner' ? '登録先を変更しました。' : owners.length ? '' : '選べる管理者がいません。';
    } catch (error) {
      status.textContent = error.message;
    } finally {
      select.value = confirmed;
      select.disabled = !select.options.length;
    }
  }
  select.addEventListener('change', () => void selectOwner('set-owner', select.value));
  void selectOwner('owner-options');
}
