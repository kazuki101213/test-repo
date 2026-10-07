import {send,download} from './ui.js';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const owned=new Set();let report;
async function save(){download('fleamarket-audit-'+Date.now()+'-diagnostic.json',report);}
async function open(url){const t=await chrome.tabs.create({url,active:false});owned.add(t.id);for(let n=0;n<60;n++){const t2=await chrome.tabs.get(t.id);if(t2.status==='complete'){await pause(900);break;}await pause(300);}await chrome.scripting.executeScript({target:{tabId:t.id},files:['content.js']});return t.id;}
async function ask(id,type,extra={}){const r=await chrome.tabs.sendMessage(id,{type:'fm:'+type,...extra});if(!r?.ok)throw new Error(r?.error||'画面の応答なし');return r.value;}
async function close(id){owned.delete(id);await chrome.tabs.remove(id).catch(()=>{});}
async function confirm(a){const tab=await open(a.identity.pageUrl||a.listUrl);try{await ask(tab,a.site==='flea'?'list':'identity',{account:a,recipe:{includeCompleted:true}});}finally{await close(tab);}}
try{
 const x=await send('export');report={kind:'readonly-audit',auditVersion:1,version:x.version,exportedAt:new Date().toISOString(),profileId:x.profileId,connected:x.connected,accounts:[],pages:[],errors:[]};
 const accounts=x.settings.accounts.filter(a=>a.enabled&&['flea','rakuma'].includes(a.site));
 for(const original of accounts){const a=structuredClone(original);a.identity.pageUrl=a.site==='rakuma'?'https://fril.jp/mypage':a.listUrl;const entry={id:a.id,site:a.site,listUrl:a.listUrl,links:0,checked:0};report.accounts.push(entry);
  try{await confirm(a);entry.identityConfirmed=true;const tab=await open(a.listUrl);let data;try{data=await ask(tab,'list',{account:{...a,_identityConfirmed:true},recipe:{includeCompleted:true}});report.pages.push({account:a.label,stage:'audit-list',...await ask(tab,'diagnostic')});}finally{await close(tab);}if(data.auth)throw new Error(data.auth);if(data.incomplete)throw new Error('購入一覧の取得が未完了');entry.links=data.links.length;
   for(const url of data.links.slice(0,40)){await confirm(a);const tx=await open(url);try{const page={account:a.label,stage:'audit-detail',...await ask(tx,'diagnostic')};try{page.transaction=await ask(tx,'detail',{account:{...a,_identityConfirmed:true},recipe:{detailWaitMs:1000}});}catch(e){page.readError=e.message;}report.pages.push(page);entry.checked++;document.getElementById('status').textContent=a.label+' '+entry.checked+'/'+Math.min(entry.links,40)+'件を確認';}finally{await close(tx);}}
  }catch(e){report.errors.push({account:a.label,error:e.message});}
 }
 report.exportedAt=new Date().toISOString();report.completed=true;await save();document.getElementById('status').textContent='読み取り検証が終了しました。';
}catch(e){if(report){report.errors.push({error:e.message});await save();}document.getElementById('status').textContent=e.message;}finally{for(const id of owned)await close(id);}
