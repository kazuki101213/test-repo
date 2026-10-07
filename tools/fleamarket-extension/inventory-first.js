export async function inventoryFirstStep(job,a,services){
 const {rpc,navigate,read,save,nextAccount,log,dbSite,verifyAccount}=services;
 const task=async(item,reason,note='')=>rpc('reconcile_marketplace_tracking',{p_marketplace:dbSite,p_account_label:a.label,p_marketplace_item_id:item.itemId||null,p_site_tracking_no:null,p_confirmation_status:reason,p_details:JSON.stringify({inventory_id:item.id,reason,note:'名前='+a.identity.text+'; '+note})});
 const complete=async()=>{
  await rpc('reconcile_marketplace_tracking',{p_marketplace:dbSite,p_account_label:a.label,p_marketplace_item_id:null,p_site_tracking_no:null,p_confirmation_status:'inventory_search_complete',p_details:JSON.stringify({day:job.inventoryDay,candidate_ids:job.candidates.filter(i=>i.itemId?.trim()).map(i=>i.id),found_ids:job.foundIds,stop_reason:job.searchStop})});
  await nextAccount(job);
 };
 if(job.stage==='inventory'){
  const data=await rpc('marketplace_tracking_candidates',{p_marketplace:dbSite});
  job.candidates=data.items;job.cutoff=data.cutoff;job.inventoryDay=data.day;job.foundIds=[];job.matchRows=[];job.index=0;job.dateUnknown=false;
  if(verifyAccount)await verifyAccount(job,a);
  for(const item of job.candidates.filter(i=>!i.itemId?.trim()))await task(item,'商品ID記載なし');
  if(!job.candidates.some(i=>i.itemId?.trim())){job.searchStop='no-candidates';return complete();}
  job.stage='list';job.pageUrl=a.listUrl;return save(job);
 }
 if(job.stage==='list'){
  await navigate(job,a,job.pageUrl);
  const data=await read(job.tabId,'list',{account:a,recipe:{includeCompleted:true,inventoryFirst:true,referenceDay:job.inventoryDay}});
  if(data.auth)throw new Error(data.auth);if(data.incomplete||!Array.isArray(data.inventoryRows)||(!data.inventoryRows.length&&!data.emptyConfirmed))throw new Error('購入一覧の商品ID・購入日を確認できません');
  for(const row of data.inventoryRows){
   if(row.purchasedAt&&row.purchasedAt<job.cutoff){job.searchStop='month-cutoff';break;}
   if(!row.purchasedAt){job.dateUnknown=true;continue;}
   for(const item of job.candidates.filter(i=>i.itemId===row.itemId)){
    if(job.foundIds.includes(item.id))continue;
    job.foundIds.push(item.id);job.matchRows.push({inventory:item,url:row.url,itemId:row.itemId});
   }
  }
  const pending=job.candidates.filter(i=>i.itemId?.trim()&&!job.foundIds.includes(i.id));
  if(!pending.length)job.searchStop='all-found';
  job.seenPages.push(job.pageUrl);
  if(!job.searchStop&&pending.length&&data.continuationUnconfirmed)throw new Error('購入一覧の続きを確認できません。未一致とは判定しません');
  if(!job.searchStop&&data.nextUrl){
   if(job.seenPages.includes(data.nextUrl)||job.seenPages.length>=20)throw new Error('購入一覧のページ重複・上限に達しました。未一致とは判定しません');
   job.pageUrl=data.nextUrl;return save(job);
  }
  if(job.dateUnknown&&pending.length)throw new Error('購入日の表示を確認できないため検索範囲を確定できません');if(!job.searchStop)job.searchStop='end-of-list';
  job.stage='detail';return save(job);
 }
 if(job.stage==='detail'){
  if(job.index>=job.matchRows.length)return complete();
  const row=job.matchRows[job.index];await navigate(job,a,row.url);
  const tx=await read(job.tabId,'detail',{account:a,recipe:{scope:'main'}});
  if(tx.auth)throw new Error(tx.auth);
  job.counts.checked++;
  if(tx.itemId!==row.itemId||tx.role==='seller'){await task(row.inventory,'画面確認待ち','商品IDまたは購入者側の詳細を確認できません');}
  else if(!tx.trackingNo||tx.trackingAmbiguous){await task(row.inventory,'追跡番号記載なし',tx.trackingAmbiguous?'番号を1件に確定できません':'');}
  else{
   const result=await rpc('reconcile_marketplace_tracking',{p_marketplace:dbSite,p_account_label:a.label,p_marketplace_item_id:row.itemId,p_site_tracking_no:tx.trackingNo,p_confirmation_status:null,p_details:JSON.stringify({inventory_id:row.inventory.id,reason:'追跡番号登録',note:'名前='+a.identity.text+'; 購入一覧の商品ID一致を確認'})});
   if(result.result==='updated')job.counts.updated++;await log('info',result.status||result.result,{account:a.label,sku:row.inventory.sku,itemId:row.itemId});
  }
  job.index++;return save(job);
 }
 throw new Error('在庫先行の巡回状態が不正です');
}
