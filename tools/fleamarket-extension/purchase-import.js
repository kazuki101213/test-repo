export async function purchaseImportStep(job,a,s){
 const {rpc,navigate,read,save,nextAccount,verifyAccount,task,log,dbSite}=s;
 if(s.lease&&await s.lease(job,a,'acquire')!==true)return save(job);
 const note=async(row,message)=>{job.counts.errors++;await task(a,'画面確認待ち','purchases','サイト='+a.site+'; 名前='+a.identity.text+'; 商品ID='+(row?.marketplace_item_id||'未確認')+'; 商品名='+(row?.title||'未確認')+'; '+message,row?.marketplace_item_id||null);};
 if(job.stage==='purchase-context'){
  const c=await rpc('marketplace_purchase_context',{p_marketplace:dbSite});
  if(!/^\d{4}-\d{2}-\d{2}$/.test(c.day)||!/^\d{4}-\d{2}-\d{2}$/.test(c.cutoff)||!Array.isArray(c.knownIds))throw new Error('仕入れリストの照合条件を確認できません');
  job.inventoryIds=Array.isArray(c.inventoryIds)?c.inventoryIds:[];job.inventoryStreak=0;job.purchaseInventoryEnd=false;job.purchaseDay=c.day;job.purchaseCutoff=c.cutoff;job.knownIds=c.knownIds;job.purchaseSeen=[];job.purchasePages=0;job.purchaseQueue=[];job.index=0;
  await verifyAccount(job,a);job.stage='purchase-list';job.pageUrl=a.listUrl;job.purchaseNavigate=true;return save(job);
 }
 if(job.stage==='purchase-list'){
  if(job.purchaseNavigate)await navigate(job,a,job.pageUrl);
  const data=await read(job.tabId,'list',{account:a,recipe:{includeCompleted:true,purchaseImport:true,referenceDay:job.purchaseDay}});
  if(data.auth)throw new Error(data.auth);
  if(data.incomplete||!Array.isArray(data.purchaseRows)||(!data.purchaseRows.length&&!data.emptyConfirmed))throw new Error('購入履歴の商品情報を確認できません');
  const fresh=data.purchaseRows.filter(r=>!job.purchaseSeen.includes(r.marketplace_item_id));
  if(job.purchasePages&&fresh.length===0&&!data.emptyConfirmed)throw new Error('購入一覧の続きを読み込めません。取得完了とは判定しません');
  job.purchasePages++;job.purchaseQueue=[];job.index=0;
  for(const row of fresh){
   job.purchaseSeen.push(row.marketplace_item_id);
   if(job.inventoryIds.includes(row.marketplace_item_id)){
    job.inventoryStreak++;job.counts.skipped++;
    if(job.inventoryStreak>=5){job.purchaseInventoryEnd=true;break;}
    continue;
   }
   job.inventoryStreak=0;
   if(row.cancelled||row.purchased_at&&row.purchased_at<job.purchaseCutoff||job.knownIds.includes(row.marketplace_item_id)){job.counts.skipped++;continue;}
   if(row.purchased_at&&row.purchased_at>job.purchaseDay){await note(row,'購入日が未来のため追加しません');continue;}
   job.purchaseQueue.push(row);
  }
  const dated=data.purchaseRows.filter(r=>r.purchased_at).map(r=>r.purchased_at);
  const ordered=dated.every((d,i)=>!i||d<=dated[i-1]);
  job.purchaseEnd=!!job.purchaseInventoryEnd||!!data.emptyConfirmed||ordered&&data.purchaseRows.length>0&&data.purchaseRows.every(r=>!!r.purchased_at)&&dated.some(d=>d<job.purchaseCutoff);
  job.purchaseNext=data.nextUrl||null;job.purchaseContinuation=data.continuationUnconfirmed===true;
  job.stage='purchase-detail';return save(job);
 }
 if(job.stage==='purchase-detail'){
  if(job.index>=job.purchaseQueue.length){
   if(job.purchaseEnd)return nextAccount(job);
   if(job.purchasePages>=20)throw new Error('購入一覧が20回の上限に達しました。取得範囲の確認が必要です');
   if(job.purchaseNext){if(job.seenPages.includes(job.purchaseNext))throw new Error('購入一覧のページが重複しています');job.seenPages.push(job.pageUrl);job.pageUrl=job.purchaseNext;job.purchaseNavigate=true;job.stage='purchase-list';return save(job);}
   // Return to the list before reading more: detail navigation must never be mistaken for a list.
   await navigate(job,a,job.pageUrl);const more=await read(job.tabId,'purchaseMore',{account:a,recipe:{includeCompleted:true,purchaseImport:true,referenceDay:job.purchaseDay},seenIds:job.purchaseSeen});
   if(more.auth)throw new Error(more.auth);if(more.more){job.purchaseNavigate=false;job.stage='purchase-list';return save(job);}
   if(!more.endConfirmed)throw new Error('購入一覧の末尾を確認できません');return nextAccount(job);
  }
  let row={...job.purchaseQueue[job.index]};
  if(!row.purchased_at||!row.title||row.cost_amount===null){
   await navigate(job,a,row.detailUrl);const d=await read(job.tabId,'purchaseDetail',{account:a,itemId:row.marketplace_item_id,recipe:{scope:'main'}});
   if(d.auth)throw new Error(d.auth);if(d.cancelled){job.counts.skipped++;job.index++;return save(job);}
   row={...row,purchased_at:row.purchased_at||d.purchased_at,title:row.title||d.title,cost_amount:row.cost_amount??d.cost_amount};
  }
  job.counts.checked++;
  if(!row.purchased_at||!row.title){await note(row,'購入日または商品名を確認できないため追加しません');}
  else if(row.purchased_at>=job.purchaseCutoff&&row.purchased_at<=job.purchaseDay){
   const result=await rpc('marketplace_purchase_import',{p_marketplace:dbSite,p_account_label:a.label,p_purchases:[row]});
   job.counts.imported+=Number(result.inserted)||0;job.counts.skipped+=Number(result.skipped)||0;
   if(result.rejected)await note(row,'保存条件に一致しないため追加されませんでした');
   if(result.inserted)await log('info','仕入れリストへ追加',{account:a.label,itemId:row.marketplace_item_id});
   job.knownIds.push(row.marketplace_item_id);
  }else job.counts.skipped++;
  job.index++;return save(job);
 }
 throw new Error('仕入れリストの取得状態が不正です');
}
