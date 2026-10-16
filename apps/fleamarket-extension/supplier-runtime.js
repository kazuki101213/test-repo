import {borrowSiteTab,restoreSiteTab} from './existing-tabs.js';
import {siteFor,assertSiteUrl,itemId} from './core.js';
export async function supplierQueuedOperations({settings,rpc,tabs,content,log}){
 const accounts=settings.accounts.filter(account=>account.enabled);if(settings.mode==='diagnostic'||!accounts.length)return;
 const rows=await rpc('extension_supplier_queue',{p_account_ids:accounts.map(account=>account.id)});if(!Array.isArray(rows)||!rows.length)return;
 const job=rows[0],account=accounts.find(value=>value.id===job.account_id);if(!account||!await rpc('extension_claim_supplier_operation',{p_id:job.id,p_account_id:account.id}))return;
 let borrowed,last,status='failed',messages=[],note='',sending=false;
 async function go(url){assertSiteUrl(account.site,url);const tab=await tabs.get(borrowed.id);if(tab.url!==last)throw Error('利用者がタブを変更したため停止しました');await tabs.update(borrowed.id,{url,active:account.site==='mercari'});last=url;borrowed.lastUrl=url;
  for(let n=0;n<60;n++){const current=await tabs.get(borrowed.id);if(current.status==='complete'){if(siteFor(current.url)!==account.site)throw Error('追加認証またはログインが必要です');last=current.url;borrowed.lastUrl=last;await new Promise(resolve=>setTimeout(resolve,700));return;}await new Promise(resolve=>setTimeout(resolve,300));}throw Error('仕入先の表示が時間切れになりました');
 }
 try{
  borrowed=await borrowSiteTab(tabs,account.site);last=borrowed.originalUrl;
  await go(account.identity.pageUrl||account.listUrl);const verified=await content(borrowed.id,'identity',{account});if(verified.confirmed!==true)throw Error('購入アカウントを確認できません');
  let url=account.listUrl,target=null;const seen=new Set();
  for(let n=0;url&&n<50;n++){
   if(seen.has(url))throw Error('購入一覧のページ送りが循環しています');seen.add(url);await go(url);
   const list=await content(borrowed.id,'list',{account,recipe:{...settings.recipes[account.site],includeCompleted:true}});if(list.auth)throw Error(list.auth);
   const matches=list.links.filter(link=>itemId(account.site,link)===job.external_id);if(matches.length>1)throw Error('取引URLを1件に確認できません');if(matches.length===1){target=matches[0];break;}url=list.nextUrl;
  }
  if(!target)throw Error('選択した購入アカウントの一覧に対象商品がありません');await go(target);
  const before=await content(borrowed.id,'messageDetail',{account,recipe:settings.recipes[account.site]||{}});if(before.auth||before.itemId!==job.external_id)throw Error('取引の商品IDが一致しません');messages=before.messages||[];
  if(job.kind==='send'){
   sending=true;
   const sent=await content(borrowed.id,'sendMessage',{account,recipe:settings.recipes[account.site]||{},itemId:job.external_id,body:job.body});if(sent.clicked!==true)throw Error('送信結果を確認できません');
   await new Promise(resolve=>setTimeout(resolve,1500));const after=await content(borrowed.id,'messageDetail',{account,recipe:settings.recipes[account.site]||{}});if(after.auth||after.itemId!==job.external_id)throw Error('送信後の取引を確認できません');messages=after.messages||[];if(!messages.some(message=>message.author_role==='self'&&message.body===job.body))throw Error('送信結果を確認できません。自動再送しません');
  }
  status='succeeded';note=job.kind==='send'?'送信を確認しました':'取引メッセージを取得しました';
 }catch(error){status=sending?'uncertain':'failed';note=error.message;await log('error','仕入先との連絡を停止しました。自動再試行しません：'+note);}
 finally{if(borrowed)await restoreSiteTab(tabs,borrowed).catch(()=>{});}
 await rpc('extension_finish_supplier_operation',{p_id:job.id,p_status:status,p_messages:messages,p_note:note});
}
