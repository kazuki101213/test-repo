import {send,download} from './ui.js';
import {PRODUCTION_PLAN} from './production-plan.js';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
try{
 let x;for(let n=0;n<120;n++){x=await send('export');if(!x.job)break;await pause(1000);}
 if(x.version!=='0.1.24')throw new Error('新方式の0.1.24が読み込まれるまで設定を変更しません');
 if(x.job)throw new Error('巡回が継続中です。設定は変更しませんでした');
 const expected=PRODUCTION_PLAN.profiles[x.profileId],enabled=x.settings.accounts.filter(a=>a.enabled);
 if(!expected||enabled.length!==expected.length||expected.some(e=>!enabled.some(a=>a.id===e.id&&a.identity?.text===e.name&&a.listUrl===e.listUrl)))throw new Error('登録済みアカウントの対応が一致しません');
 if(!x.connected)throw new Error('管理アプリ連携を確認できません');
 const settings=structuredClone(x.settings);settings.mode='tracking';settings.trackingPolicy='inventory-first';settings.recipes={...settings.recipes,...structuredClone(PRODUCTION_PLAN.recipes)};
 await send('save',{settings});
 const actual=await send('export');
 if(actual.settings.mode!=='tracking'||actual.settings.trackingPolicy!=='inventory-first'||['flea','rakuma'].some(site=>actual.settings.recipes[site]?.trackingEnabled!==true))throw new Error('保存後の有効化設定が一致しません');
 download('fleamarket-extension-'+Date.now()+'-diagnostic.json',actual);
 document.getElementById('result').textContent='追跡番号自動登録の保存設定を確認しました。';
}catch(e){document.getElementById('result').textContent=e.message;}
