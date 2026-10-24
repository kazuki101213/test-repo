// Price-only changes; no relisting, auction conversion, messages or purchases.
export const PRICE_POLICY={enabled:false,hour:12,amount:100,startDay:'2026-10-25',sites:['mercari'],verifiedAccounts:[],floor:null};
export function priceClock(now=Date.now()){const parts=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hourCycle:'h23'}).formatToParts(new Date(now)),get=k=>parts.find(p=>p.type===k).value;return {day:`${get('year')}-${get('month')}-${get('day')}`,hour:Number(get('hour'))};}
export function titleSerial(title){const ids=[...String(title||'').normalize('NFKC').matchAll(/[【\[]([0-9]+[a-z]*)[】\]]/gi)].map(m=>m[1].toLowerCase());return ids.length===1?ids[0]:null;}
export function priceDue(policy,settings,records,now=Date.now()){const {day,hour}=priceClock(now);return policy.enabled===true&&settings.priceReductionEnabled!==false&&settings.mode!=='diagnostic'&&!records.job&&!records.authProblem&&hour>=policy.hour&&day>=policy.startDay;}
export async function ensurePriceAlarm(alarms,settings,policy=PRICE_POLICY,now=Date.now()){
 const eligible=policy.enabled&&settings.priceReductionEnabled!==false&&settings.mode!=='diagnostic'&&settings.accounts.some(a=>a.enabled&&policy.verifiedAccounts.includes(a.id));
 if(!eligible){if(await alarms.get('fm:price'))await alarms.clear('fm:price');return;}
 const clock=priceClock(now),today=Date.parse(clock.day+'T12:00:00+09:00'),when=today>now?today:today+86400000,existing=await alarms.get('fm:price');
 if(!existing||Math.abs(existing.scheduledTime-when)>1000)await alarms.create('fm:price',{when});
}

/** Runs inside the registered seller's existing tab. inspect never writes or clicks. */
export async function mercariPricePage(args){
 try{
 const {itemId,serial,action='inspect',before,after,fingerprint}=args,visible=e=>!!e&&e.getClientRects().length>0&&getComputedStyle(e).visibility!=='hidden',norm=s=>String(s||'').replace(/\s+/g,' ').trim();
 if(location.hostname!=='jp.mercari.com'||!/^m[0-9]+$/.test(itemId)||!['/item/'+itemId,'/sell/edit/'+itemId].includes(location.pathname))throw Error('値下げ対象の商品ID・画面が一致しません');
 const text=norm(document.body.innerText);
 if(document.querySelector('input[type=password],input[autocomplete=one-time-code]')||/ログインしてください|認証コードを入力|追加認証|セキュリティチェック|ロボットではない/.test(text))throw Error('ログイン・追加認証が必要です');
 const root=document.querySelector('main')||document.body;
 const fields=[...root.querySelectorAll('input,textarea,select')].filter(visible);
 const info=()=>({url:location.origin+location.pathname,headings:[...root.querySelectorAll('h1,h2')].filter(visible).map(e=>norm(e.innerText)).slice(0,8),fields:fields.map(e=>({tag:e.tagName,name:e.name,type:e.type,testId:e.getAttribute('data-testid'),label:norm([...(e.labels||[])].map(l=>l.innerText).join(' ')),required:e.required,min:e.min,max:e.max})),buttons:[...root.querySelectorAll('button,a')].filter(visible).map(e=>norm(e.innerText)).filter(t=>/編集|変更|保存|出品|価格/.test(t)).slice(0,15)});
 if(action==='structure')return info();
 const buttonLabels=[...root.querySelectorAll('button,a')].filter(visible).map(e=>norm(e.innerText));
 if(buttonLabels.some(t=>/^(取引画面へ|取引画面を見る|公開を再開する)$/.test(t))||/この商品は売り切れました|公開停止中/.test(text))return {eligible:false,reason:'販売中ではありません',...info()};
 if(buttonLabels.some(t=>/^(入札する|入札に進む)$/.test(t))||/オークション終了まで|入札件数\s*[0-9]/.test(text))return {eligible:false,reason:'オークション形式は対象外',...info()};
 if(location.pathname==='/item/'+itemId){
  const headings=[...root.querySelectorAll('h1')].filter(visible);if(headings.length!==1)throw Error('商品タイトルを1件に確認できません');
  const title=norm(headings[0].innerText),serials=[...title.normalize('NFKC').matchAll(/[【\[]([0-9]+[a-z]*)[】\]]/gi)].map(m=>m[1].toLowerCase());
  if(serials.length!==1||serials[0]!==serial)throw Error('商品タイトルの通番号が一致しません');
  const edits=[...root.querySelectorAll('a[href]')].filter(e=>visible(e)&&new URL(e.href).hostname==='jp.mercari.com'&&new URL(e.href).pathname==='/sell/edit/'+itemId);
  const editButtons=[...root.querySelectorAll('button')].filter(e=>visible(e)&&/^(商品を編集する|商品の編集|商品を編集)$/.test(norm(e.innerText)));
  if(edits.length!==1&&(edits.length!==0||editButtons.length!==1))throw Error('出品者の商品編集リンクを1件に確認できません');
  return {eligible:true,title,editUrl:edits[0]?.href||location.origin+'/sell/edit/'+itemId,...info()};
 }
 const titles=fields.filter(e=>e.tagName==='INPUT'&&e.name==='name'),prices=fields.filter(e=>e.tagName==='INPUT'&&e.name==='price');
 if(titles.length!==1||prices.length!==1)return {eligible:false,reason:'価格・タイトル入力欄を1件に確認できません',...info()};
 const title=norm(titles[0].value),serials=[...title.normalize('NFKC').matchAll(/[【\[]([0-9]+[a-z]*)[】\]]/gi)].map(m=>m[1].toLowerCase());
 if(serials.length!==1||serials[0]!==serial)throw Error('編集画面の通番号が一致しません');
 const input=prices[0],price=Number(input.value.replaceAll(',',''));if(!Number.isInteger(price)||price<300||price>9999999||input.disabled||input.readOnly)throw Error('現在価格を確認できません');
 const controls=[...root.querySelectorAll('button')].filter(e=>visible(e)&&norm(e.innerText)==='変更する');if(controls.length!==1||controls[0].disabled)throw Error('価格変更ボタンを1件に確認できません');
 // Includes all other form fields; do not return their values or credentials.
 const data=[...root.querySelectorAll('input,textarea,select')].filter(e=>e!==input).map(e=>[e.tagName,e.name,e.type,e.value,e.checked]);
 const bytes=new TextEncoder().encode(JSON.stringify(data)),digest=await crypto.subtle.digest('SHA-256',bytes),hash=[...new Uint8Array(digest)].map(v=>v.toString(16).padStart(2,'0')).join('');
 if(action==='inspect')return {eligible:true,title,price,fingerprint:hash,...info()};
 if(!Number.isInteger(before)||after!==before-100||after<300||after>9999999||hash!==fingerprint||!['prepare','submit'].includes(action))throw Error('価格変更条件が一致しません');
 if(action==='prepare'){if(price!==before)throw Error('準備前に価格が変更されました');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,String(after));input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));return {prepared:input.value===String(after)};}
 if(price!==after||!input.checkValidity()||input.form&&!input.form.checkValidity())throw Error('送信直前の価格・必須項目を確認してください');
 setTimeout(()=>controls[0].click(),100);return {submitRequested:true};
 }catch(error){return {__error:error.message};}
}

export async function runDailyPriceReduction({settings,records,profileId,storage,rpc,openSession,log,fetchInspection,continueWork,policy=PRICE_POLICY,now=Date.now()}){
 const accounts=settings.accounts.filter(a=>a.enabled&&a.site==='mercari'&&['mercari-1','mercari-2'].includes(a.id)),clock=priceClock(now);
 await storage.set({repricingPolicy:policy});
 const rawRequest=await fetchInspection?.(),selection=rawRequest?.targets?.find(t=>t.profileId===profileId),request=selection?{...rawRequest,...selection}:rawRequest,saved=await storage.get(['repricingInspection','repricingJob','repricingDaily']);
 if(request?.kind==='price-readonly'&&request.profileId===profileId&&request.id!==saved.repricingInspection?.id&&/^[-0-9a-f]{36}$/i.test(request.id||'')&&Date.parse(request.issuedAt)<=now&&Date.parse(request.expiresAt)>now&&Date.parse(request.expiresAt)-Date.parse(request.issuedAt)<=15*60000){
  const account=accounts.find(a=>a.id===request.accountId);if(!account)return false;
  await storage.set({repricingInspection:{id:request.id,status:'running',readOnly:true,accountId:account.id}});let session;const proof=[];
  try{session=await openSession(account);const candidates=await rpc('marketplace_price_candidates',{p_account_id:account.id}),target=candidates.find(c=>c.external_id===request.itemId);if(!target)throw Error('対象在庫がありません');const serial=target.sku.split('-')[0].toLowerCase();await session.go(target.url);try{proof.push(await session.price({itemId:target.external_id,serial,action:'inspect'}));if(proof[0].eligible){await session.go(proof[0].editUrl);proof.push(await session.price({itemId:target.external_id,serial,action:'inspect'}));}}catch(error){proof.push({error:error.message,structure:await session.price({itemId:target.external_id,serial,action:'structure'})});throw error;}await storage.set({repricingInspection:{id:request.id,accountId:account.id,status:'completed',readOnly:true,at:new Date().toISOString(),proof}});}catch(error){await storage.set({repricingInspection:{id:request.id,accountId:account.id,status:'failed',readOnly:true,error:error.message,proof}});}finally{await session?.close();}return true;
 }
 if(!priceDue(policy,settings,records,now)||!accounts.some(a=>policy.verifiedAccounts.includes(a.id)))return false;
 let job=saved.repricingJob,daily=saved.repricingDaily||{};
 if(job?.day!==clock.day){job={day:clock.day,accounts:accounts.filter(a=>policy.verifiedAccounts.includes(a.id)&&daily[a.id]?.day!==clock.day).map(a=>a.id),accountIndex:0,index:0,queue:null,updated:0,skipped:0,errors:0};}
 if(job.accountIndex>=job.accounts.length)return false;
 const account=accounts.find(a=>a.id===job.accounts[job.accountIndex]);if(!account)return false;
 let session;
 try{
  if(!job.queue){job.queue=await rpc('marketplace_price_candidates',{p_account_id:account.id});job.index=0;}
  if(job.queue.length){session=await openSession(account);for(let n=0;n<3&&job.index<job.queue.length;n++){
   if((await storage.get('settings')).settings?.priceReductionEnabled===false){await continueWork?.(false);break;}
   const row=job.queue[job.index++];await storage.set({repricingJob:job});let claim,begun=false;
   try{
    const serial=row.sku.split('-')[0].toLowerCase();await session.go(row.url);const item=await session.price({itemId:row.external_id,serial,action:'inspect'});if(!item.eligible){job.skipped++;continue;}
    await session.go(item.editUrl);const form=await session.price({itemId:row.external_id,serial,action:'inspect'});if(!form.eligible||titleSerial(form.title)!==serial||form.price-100<300){job.skipped++;continue;}
    claim=await rpc('marketplace_price_record',{p_account_id:account.id,p_external_id:row.external_id,p_action:'reserve',p_day:clock.day,p_before:form.price,p_after:form.price-100,p_title:form.title});if(!claim?.claimed){job.skipped++;continue;}
    const args={itemId:row.external_id,serial,before:form.price,after:form.price-100,fingerprint:form.fingerprint};
    const prepared=await session.price({...args,action:'prepare'});if(!prepared.prepared)throw Error('価格の準備に失敗しました');
    if((await storage.get('settings')).settings?.priceReductionEnabled===false)throw Error('利用者の設定で値下げを停止しました');
    await rpc('marketplace_price_record',{p_account_id:account.id,p_external_id:row.external_id,p_action:'begin',p_day:clock.day,p_token:claim.token});begun=true;
    if(!(await session.price({...args,action:'submit'})).submitRequested)throw Error('変更要求の結果が不明です');
    await session.loaded();const verified=await session.priceResult({itemId:row.external_id,serial,after:args.after});if(!verified.success)throw Error('値下げ結果を確認できません');
    await rpc('marketplace_price_record',{p_account_id:account.id,p_external_id:row.external_id,p_action:'complete',p_day:clock.day,p_token:claim.token,p_note:'商品ID・通番号・変更後価格を実画面で確認'});job.updated++;await log('info','100円の値下げを完了しました',{account:account.label,itemId:row.external_id});
   }catch(error){job.errors++;if(begun)session.preserveForReview?.();if(claim?.claimed){try{await rpc('marketplace_price_record',{p_account_id:account.id,p_external_id:row.external_id,p_action:begun?'unknown':'failed',p_day:clock.day,p_token:claim.token,p_note:error.message.slice(0,200)});}catch{}}await log('error','値下げを停止しました。自動再送しません：'+error.message,{account:account.label,itemId:row.external_id});if(begun||/ログイン|認証|名前|アカウント|URL.*変更/.test(error.message)){job.index=job.queue.length;break;}}
   await storage.set({repricingJob:job});
  }}
 }catch(error){job.errors++;job.index=job.queue?.length||0;job.queue=job.queue||[];await log('error','このアカウントの値下げを停止しました：'+error.message,{account:account.label});}finally{await session?.close();}
 if(job.index>=job.queue.length){daily[account.id]={day:clock.day,at:new Date().toISOString(),updated:job.updated,skipped:job.skipped,errors:job.errors};job.accountIndex++;job.queue=null;job.index=0;await storage.set({repricingDaily:daily});}
 await storage.set({repricingJob:job});await continueWork?.(job.accountIndex<job.accounts.length&&(await storage.get('settings')).settings?.priceReductionEnabled!==false);return true;
}

/** Wait for the save navigation, then read the displayed price without another save. */
export async function mercariPriceResult({itemId,serial,after}){try{
 const end=Date.now()+15000;do{
  if(location.hostname!=='jp.mercari.com'||!['/item/'+itemId,'/sell/edit/'+itemId].includes(location.pathname))throw Error('変更後の商品ページが一致しません');
  if(location.pathname==='/sell/edit/'+itemId){await new Promise(resolve=>setTimeout(resolve,300));continue;}
  const root=document.querySelector('main')||document.body,headings=[...root.querySelectorAll('h1')].filter(e=>e.getClientRects().length),title=headings.length===1?headings[0].innerText:'',ids=[...title.normalize('NFKC').matchAll(/[【\[]([0-9]+[a-z]*)[】\]]/gi)].map(m=>m[1].toLowerCase());
  const priceNodes=[...root.querySelectorAll('[data-testid="price"]')].filter(e=>e.getClientRects().length),prices=priceNodes.map(e=>Number(e.innerText.replace(/[^0-9]/g,'')));
  if(ids.length===1&&ids[0]===serial&&prices.length===1&&prices[0]===after)return {success:true,price:after};
  await new Promise(resolve=>setTimeout(resolve,300));
 }while(Date.now()<end);throw Error('保存後の価格表示を確認できません');
 }catch(error){return {__error:error.message};}}
