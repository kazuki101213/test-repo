const ACCOUNTS={'ba92b386-e0bc-48be-b3b6-ca9550fa1a2d':'auctions-1','f29f12b6-35f2-4e9f-8312-a8321ddf3c12':'auctions-2'};
// An explicit, expiring repair never resets the scheduled run or an existing receipt reservation.
export async function runBuyerReceiptRepair({request,profileId,storage,start,now=Date.now()}){
 if(!request||request.kind!=='buyer-receipt-repair'||!/^[-0-9a-f]{36}$/i.test(request.id||'')||request.profileId!==profileId||ACCOUNTS[profileId]!==request.accountId)return false;
 const issued=Date.parse(request.issuedAt),expires=Date.parse(request.expiresAt),ids=request.itemIds;
 if(!Number.isFinite(issued)||!Number.isFinite(expires)||issued>now||expires<=now||expires-issued>15*60000||!Array.isArray(ids)||!ids.length||ids.length>10||new Set(ids).size!==ids.length||!ids.every(id=>/^[a-z][0-9]{8,14}$/.test(id)))return false;
 const state=await storage.get(['job','authProblem','sellerInspectionEvidence','buyerReceiptRepairConsumed']),done=state.buyerReceiptRepairConsumed||[],proof=state.sellerInspectionEvidence;
 if(state.job||state.authProblem||done.includes(request.id)||proof?.requestId!==request.preflightRequestId||proof?.accountId!==request.accountId||proof?.readOnly!==true||proof?.status!=='completed'||!Number.isFinite(Date.parse(proof.at))||now-Date.parse(proof.at)<0||now-Date.parse(proof.at)>15*60000)return false;
 if(!ids.every(id=>proof.receipts?.some(p=>p.itemId===id&&p.pending===true&&!p.error&&p.preflight?.ready===true&&p.preflight.received===false)))return false;
 await storage.set({buyerReceiptRepairConsumed:[...done,request.id].slice(-32)});
 await start('receipt',true,[request.accountId],request.id);
 const {job}=await storage.get('job');if(job?.id!==request.id||job.kind!=='receipt')throw Error('受取評価補修の開始状態を確認できません');
 job.receiptTargetIds=[...ids];await storage.set({job});return true;
}
