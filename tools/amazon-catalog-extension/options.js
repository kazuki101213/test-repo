const form = document.querySelector('#settings-form');
const key = document.querySelector('#key');
const status = document.querySelector('#settings-status');
const save = document.querySelector('#save');
const remove = document.querySelector('#remove');

async function update(message) {
  save.disabled = true;
  remove.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage(message);
    if (!response?.ok) throw new Error(response?.message || '設定を確認できませんでした。');
    status.textContent = response.data.configured ? 'Keepa APIキーは設定済みです。' : 'Keepa APIキーは未設定です。';
    key.value = '';
    return response.data.configured;
  } catch (error) {
    status.textContent = error.message;
    return false;
  } finally {
    save.disabled = false;
  }
}

async function change(message) {
  remove.disabled = !(await update(message));
}

form.addEventListener('submit', event => {
  event.preventDefault();
  void change({ type: 'set-key', key: key.value });
});
remove.addEventListener('click', () => void change({ type: 'set-key', key: '' }));
void change({ type: 'settings' });
