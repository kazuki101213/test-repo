import {send,download,action} from './ui.js';
async function refresh(){const s=await send('state');document.getElementById('summary').textContent=(s.connected?'管理アプリ連携済み':'初回連携が必要')+' / '+({diagnostic:'診断モード：更新・評価送信なし',tracking:s.settings.trackingPolicy==='inventory-first'?(s.settings.purchaseImportEnabled?'仕入れリスト自動取得・追跡確認：毎日午前1時':'在庫先行方式・毎日午前1時'):'追跡番号の登録有効',full:'追跡番号・受け取り評価有効'}[s.settings?.mode]||'準備中')+(s.job?' / '+s.job.account+'巡回中':'');const sel=document.getElementById('account');const selected=sel.value||localStorage.getItem('fm-account');sel.replaceChildren();for(const a of s.settings.accounts){const option=document.createElement('option');option.value=a.id;option.textContent=a.label+(a.enabled?'（登録済み）':'');sel.append(option);}if([...sel.options].some(o=>o.value===selected))sel.value=selected;document.getElementById('receipt').disabled=s.settings.mode!=='full';}
action('connect',async()=>{await send('connect');await refresh();return '管理者の権限を確認して連携しました';});
action('options',()=>chrome.runtime.openOptionsPage());
action('pick',async()=>{await send('pick',{id:document.getElementById('account').value});await refresh();return 'アカウント名を紐付けました';});
action('bind',async()=>{await send('bind',{id:document.getElementById('account').value});await refresh();return '購入一覧を登録しました';});
action('clearAccount',async()=>{const result=await send('clearAccount',{id:document.getElementById('account').value});await refresh();return result.label+'の名前と購入一覧の登録を削除しました';});
action('scan',async()=>{await send('start',{kind:'tracking'});return '巡回を開始しました。実行記録で進捗を確認できます';});
action('messages',async()=>{await send('start',{kind:'messages'});return '取引メッセージの同期を開始しました。実行記録で進捗を確認できます';});
action('purchases',async()=>{await send('start',{kind:'purchases'});return '購入履歴の同期を開始しました。管理アプリの在庫一覧にある「仕入れリスト」で確認できます';});
action('receipt',async()=>{await send('start',{kind:'receipt'});return '受け取り評価の巡回を開始しました';});
action('stop',async()=>{await send('stop');return '巡回を停止しました';});
action('diagnostic',async()=>{const d=await send('diagnostic');download('fleamarket-page-diagnostic.json',d);return '画面構造の診断を保存しました';});
document.getElementById('account').addEventListener('change',e=>localStorage.setItem('fm-account',e.target.value));
action('autoRegister',async()=>{const id=document.getElementById('account').value;const result=await send('registerSite',{id});await refresh();return result.label+' 登録済み：'+result.name;});
refresh().catch(e=>document.getElementById('message').textContent=e.message);
