// Explicit, expiring operator request. This changes only existing Mercari dispatch days.
const OWNERS={'f29f12b6-35f2-4e9f-8312-a8321ddf3c12':'mercari-1','51502a66-28a6-4af0-81ea-660e63d8b66c':'mercari-2'};
export function dispatchDaysRequest(request,profileId,now=Date.now()){
 if(request?.kind!=='mercari-dispatch-days'||!/^[-0-9a-f]{36}$/i.test(request.id||'')||request.targetDays!=='4〜7日'||!['audit','apply'].includes(request.action))return null;
 const issued=Date.parse(request.issuedAt),expires=Date.parse(request.expiresAt);
 if(!Number.isFinite(issued)||!Number.isFinite(expires)||issued>now||expires<=now||expires-issued>4*3600000)return null;
 const target=request.accounts?.find(a=>a.profileId===profileId&&a.accountId===OWNERS[profileId]);
 return target?{...request,...target}:null;
}
export async function mercariDispatchDaysPage({itemId,title:expectedTitle,action='inspect',before,fingerprint}){
 try{
 const visible=e=>!!e&&e.getClientRects().length>0&&getComputedStyle(e).visibility!=='hidden',norm=s=>String(s||'').replace(/\s+/g,' ').trim(),days=s=>norm(s).replace(/[～~–—-]/g,'〜').replace(/で発送$/,'');
 if(!/^m[0-9]{8,14}$/.test(itemId)||location.hostname!=='jp.mercari.com')throw Error('対象の商品ID・サイトが一致しません');
 const isPublic=location.pathname==='/item/'+itemId,isEdit=location.pathname==='/sell/edit/'+itemId;
 if(!isPublic&&!isEdit)throw Error('対象の商品画面ではありません');
 const deadline=Date.now()+18000;let titles;
 do{if(document.querySelector('input[type=password],input[autocomplete=one-time-code]')||/ログインしてください|文字認証|セキュリティチェック/.test(document.body.innerText))throw Error('ログイン・追加認証のため停止しました');titles=[...document.querySelectorAll(isEdit?'input[name=name]':'h1')].filter(visible);if(titles.length===1)break;await new Promise(r=>setTimeout(r,250));}while(Date.now()<deadline);
 if(titles.length!==1)throw Error('商品名を1件に確認できません');
 const title=norm(isEdit?titles[0].value:titles[0].innerText);
 if(expectedTitle&&title!==expectedTitle)throw Error('対象の商品名が変更されています');
 if(isPublic){
  if(action!=='public')throw Error('公開画面では読み取りだけ可能です');
  if(/売り切れました|SOLD OUT|公開停止中|この商品は削除されました/.test(document.body.innerText))return {eligible:false,reason:'販売中ではありません'};
  const edits=[...document.querySelectorAll('a[href]')].filter(e=>visible(e)&&new URL(e.href).origin===location.origin&&new URL(e.href).pathname==='/sell/edit/'+itemId);
  const buttons=[...document.querySelectorAll('button')].filter(e=>visible(e)&&/^商品の編集$/.test(norm(e.innerText)));
  if(edits.length!==1&&(edits.length!==0||buttons.length!==1))throw Error('自分の出品の編集操作を確認できません');
  return {eligible:true,title,editUrl:location.origin+'/sell/edit/'+itemId};
 }
 let controls=[...document.querySelectorAll('select')].filter(visible).filter(e=>/shippingDuration|shipschedule|dispatch/i.test(e.name||e.id)||[...(e.labels||[])].some(l=>/発送までの日数|発送までの期間/.test(l.innerText)));
 if(controls.length!==1){return {eligible:false,reason:'発送日数の選択欄を1件に確認できません',controls:[...document.querySelectorAll('select,input')].filter(visible).map(e=>({tag:e.tagName,name:e.name,id:e.id,labels:[...(e.labels||[])].map(l=>norm(l.innerText).slice(0,60)),options:e.tagName==='SELECT'?[...e.options].map(o=>({value:o.value,text:o.text})):undefined})).slice(0,30)};}
 const field=controls[0],current=days(field.selectedOptions[0]?.text),options=[...field.options].filter(o=>days(o.text)==='4〜7日');
 if(!['1〜2日','2〜3日','4〜7日'].includes(current)||options.length!==1||field.disabled)throw Error('発送日数の現在値または変更先を確認できません');
 const root=field.form||document.querySelector('main')||document.body;
 const snapshot=[...root.querySelectorAll('input,select,textarea')].filter(e=>e!==field).map(e=>[e.tagName,e.name,e.type,e.value,e.checked]);
 const bytes=new TextEncoder().encode(JSON.stringify(snapshot)),hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(v=>v.toString(16).padStart(2,'0')).join('');
 if(action==='inspect')return {eligible:true,title,days:current,fingerprint:hash,control:{name:field.name,id:field.id,options:[...field.options].map(o=>({value:o.value,text:o.text}))}};
 if(!['prepare','submit'].includes(action)||!['1〜2日','2〜3日'].includes(before)||hash!==fingerprint)throw Error('発送日数以外の項目が変更されています');
 if(action==='prepare'){
  if(current!==before)throw Error('準備前に発送日数が変更されています');
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(field,options[0].value);
  field.dispatchEvent(new Event('input',{bubbles:true}));field.dispatchEvent(new Event('change',{bubbles:true}));
  return {prepared:days(field.selectedOptions[0]?.text)==='4〜7日'};
 }
 if(current!=='4〜7日'||!field.checkValidity()||field.form&&!field.form.checkValidity())throw Error('保存直前の入力内容を確認できません');
 const save=[...document.querySelectorAll('button')].filter(e=>visible(e)&&!e.disabled&&norm(e.innerText)==='変更する');
 if(save.length!==1)throw Error('変更するボタンを1件に確認できません');
 setTimeout(()=>save[0].click(),100);return {submitRequested:true};
 }catch(error){return {__error:error.message};}
}
export async function collectDispatchListings(session){
 await session.go('https://jp.mercari.com/mypage');let links=await session.links();
 let link=links.find(l=>l.text==='出品中')||links.find(l=>['出品した商品','出品一覧'].includes(l.text));
 if(!link)throw Error('出品した商品の入口がありません');await session.go(link.url);
 links=await session.links();link=links.find(l=>l.text==='出品中');
 if(link)await session.go(link.url);else if(!await session.selectTab('出品中'))throw Error('出品中の一覧を選択できません');
 const rows=new Map(),pages=new Set();let complete=false;
 for(let n=0;n<50;n++){
  const page=await session.read('出品中');if(page.active&&page.active!=='出品中')throw Error('出品中以外の一覧です');
  if(!page.rows.length&&!page.empty)throw Error('出品一覧の読み取りが不完全です');
  for(const row of page.rows){if(row.status!=='出品中')continue;if(!/^m[0-9]{8,14}$/.test(row.external_id))throw Error('出品商品IDが不正です');rows.set(row.external_id,{itemId:row.external_id,serial:row.serial||null});}
  const next=page.navigation.filter(l=>['次へ','次のページ','次'].includes(l.text));
  if(next.length){if(next.length!==1||pages.has(next[0].url))throw Error('ページ送りが不明です');pages.add(next[0].url);await session.go(next[0].url);continue;}
  if(!await session.advanceList('出品中')){complete=true;break;}
 }
 if(!complete)throw Error('出品中の全一覧を確認できません');return [...rows.values()];
}
export async function runDispatchDaysUpdate({settings,records,profileId,storage,openSession,log,fetchRequest,continueWork,now=Date.now()}){
 const request=dispatchDaysRequest(await fetchRequest(),profileId,now);
 if(!request||settings.mode==='diagnostic'||records.job||records.authProblem)return false;
 const account=settings.accounts.find(a=>a.enabled&&a.site==='mercari'&&a.id===request.accountId);if(!account)return false;
 const saved=await storage.get(['dispatchDaysJob','dispatchDaysAudit']);let job=saved.dispatchDaysJob;
 if(job?.requestId===request.id&&['completed','failed','unknown'].includes(job.status))return false;
 if(job?.requestId!==request.id){
  if(job?.results?.some(r=>['submitting','unknown'].includes(r.state)))return false;
  if(job?.status==='running')return false;
  if(request.action==='apply'&&(saved.dispatchDaysAudit?.requestId!==request.auditRequestId||saved.dispatchDaysAudit?.accountId!==account.id||saved.dispatchDaysAudit?.status!=='completed'||now-Date.parse(saved.dispatchDaysAudit.at)>60*60000))return false;
  job={requestId:request.id,accountId:account.id,action:request.action,status:'running',index:0,results:[],startedAt:new Date(now).toISOString()};
  if(request.action==='apply')job.targets=saved.dispatchDaysAudit.targets;
  await storage.set({dispatchDaysJob:job});
 }
 let session;
 try{
  session=await openSession(account);
  if(request.action==='audit'){
   job.targets=await collectDispatchListings(session);
   if(job.targets.length){const row=job.targets[0];await session.go('https://jp.mercari.com/item/'+row.itemId);const publicProof=await session.dispatchDays({...row,action:'public'});if(!publicProof.eligible)throw Error('最初の出品を確認できません');await session.go(publicProof.editUrl);job.sample=await session.dispatchDays({...row,title:publicProof.title,action:'inspect'});if(!job.sample.eligible)throw Error(job.sample.reason);}
   job.status='completed';job.at=new Date().toISOString();await storage.set({dispatchDaysAudit:job,dispatchDaysJob:job});return true;
  }
  for(let n=0;n<6&&job.index<job.targets.length;n++){
   if(Date.now()>Date.parse(request.expiresAt))throw Error('変更依頼の有効期限を過ぎました');
   const target=job.targets[job.index],old=job.results.find(r=>r.itemId===target.itemId);
   if(old?.state==='submitting'||old?.state==='unknown')throw Error('結果未確認の保存を再実行しません');
   const result={itemId:target.itemId,serial:target.serial,state:'inspecting'};job.results.push(result);await storage.set({dispatchDaysJob:job});
   let submitted=false;
   try{
    await session.go('https://jp.mercari.com/item/'+target.itemId);const item=await session.dispatchDays({...target,action:'public'});
    if(!item.eligible){result.state='skipped';result.reason=item.reason;job.index++;continue;}
    await session.go(item.editUrl);const form=await session.dispatchDays({...target,title:item.title,action:'inspect'});
    if(!form.eligible)throw Error(form.reason);result.before=form.days;
    if(form.days==='4〜7日'){result.state='already';result.after=form.days;job.index++;continue;}
    const args={...target,title:item.title,before:form.days,fingerprint:form.fingerprint};
    if(!(await session.dispatchDays({...args,action:'prepare'})).prepared)throw Error('変更内容を準備できません');
    result.state='submitting';await storage.set({dispatchDaysJob:job});submitted=true;
    if(!(await session.dispatchDays({...args,action:'submit'})).submitRequested)throw Error('保存結果が不明です');
    await session.loaded();await session.go(item.editUrl);
    const verified=await session.dispatchDays({...target,title:item.title,action:'inspect'});
    if(!verified.eligible||verified.days!=='4〜7日'||verified.fingerprint!==form.fingerprint)throw Error('保存後の発送日数・他項目を確認できません');
    result.state='completed';result.after=verified.days;result.verifiedAt=new Date().toISOString();job.index++;
   }catch(error){result.state=submitted?'unknown':'failed';result.error=error.message;if(submitted)session.preserveForReview?.();throw error;}
   finally{await storage.set({dispatchDaysJob:job});}
  }
  job.status=job.index===job.targets.length?'completed':'running';job.at=new Date().toISOString();await storage.set({dispatchDaysJob:job});await continueWork?.(job.status==='running');
 }catch(error){job.status=['submitting','unknown'].includes(job.results?.at(-1)?.state)?'unknown':'failed';job.error=error.message;job.at=new Date().toISOString();await storage.set({dispatchDaysJob:job});await continueWork?.(false);await log('error','発送日数の変更を停止しました。再送しません：'+error.message);}
 finally{await session?.close();}return true;
}
