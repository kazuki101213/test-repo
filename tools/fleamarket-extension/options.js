import {SITES} from './core.js';
import {send,download,action} from './ui.js';
let current;
async function refresh(){const s=await send('state');current=s.settings;document.getElementById('summary').textContent=(s.connected?'管理アプリ連携済み':'初回連携が必要')+' / 未送信の確認タスク '+(s.outbox?.length||0)+'件';for(const key of ['mode','trackingHour','receiptHour'])document.getElementById(key).value=current[key];document.getElementById('config').value=JSON.stringify(current,null,2);
  const rows=document.getElementById('accounts');rows.replaceChildren();for(const a of current.accounts){const row=document.createElement('tr');for(const text of [a.label,a.enabled?'登録済み':'未登録',a.identity?.text||'—']){const td=document.createElement('td');td.textContent=text;row.append(td);}const td=document.createElement('td'),open=document.createElement('button');open.textContent='サイトを開く';open.className='secondary';open.onclick=()=>chrome.tabs.create({url:a.listUrl||SITES[a.site].home});td.append(open);if(a.enabled||a.identity){const disable=document.createElement('button');disable.textContent='登録を削除';disable.className='secondary';disable.onclick=async()=>{try{disable.disabled=true;await send('clearAccount',{id:a.id});await refresh();document.getElementById('message').textContent=a.label+'の名前と購入一覧の登録を削除しました';}catch(e){document.getElementById('message').textContent=e.message;disable.disabled=false;}};td.append(disable);}row.append(td);rows.append(row);}
  document.getElementById('job').textContent=s.job?`${s.job.account}：${s.job.stage} / 確認 ${s.job.counts.checked}件・更新 ${s.job.counts.updated}件・評価 ${s.job.counts.rated}件`:'現在の巡回はありません';
  document.getElementById('events').textContent=(s.events||[]).slice(0,50).map(e=>`${new Date(e.at).toLocaleString('ja-JP')} ${e.account||''} ${e.text}${e.itemId?' / '+e.itemId:''}${e.sku?' / SKU '+e.sku:''}`).join('\n')||'実行記録はまだありません';
}
action('save',async()=>{const next=structuredClone(current);next.mode=document.getElementById('mode').value;next.trackingHour=Number(document.getElementById('trackingHour').value);next.receiptHour=Number(document.getElementById('receiptHour').value);await send('save',{settings:next});await refresh();return '設定を保存しました';});
action('connect',async()=>{await send('connect');await refresh();return '管理者の権限を確認して連携しました';});
action('disconnect',async()=>{await send('disconnect');await refresh();return '連携を解除しました';});
action('reload',async()=>{await refresh();return '最新の記録を表示しました';});
action('export',async()=>{download('fleamarket-extension-diagnostics.json',await send('export'));return '設定と診断記録を保存しました。ログイン認証情報は含めません';});
action('apply',async()=>{await send('save',{settings:JSON.parse(document.getElementById('config').value)});await refresh();return '画面設定を適用しました';});
document.getElementById('importFile').addEventListener('change',async e=>{try{const data=JSON.parse(await e.target.files[0].text());document.getElementById('config').value=JSON.stringify(data.settings||data,null,2);}catch(err){document.getElementById('message').textContent=err.message;}});
refresh().catch(e=>document.getElementById('message').textContent=e.message);
