export function installBuyerReceiptRepair(source){
 if(source.includes("from './buyer-receipt-repair.js'"))return source;
 const hook='await retryYahooTrackingRepair();';if(!source.includes(hook))throw Error('repair hook missing');
 const row='for(const row of data.inventoryRows||[]){';if(!source.includes(row))throw Error('receipt candidate loop missing');
 source="import {runBuyerReceiptRepair} from './buyer-receipt-repair.js';\n"+source;
 source=source.replace(hook,hook+'await retryBuyerReceiptRepair();').replace(row,row+"if(job.kind==='receipt'&&job.receiptTargetIds&&!job.receiptTargetIds.includes(row.itemId))continue;");
 return source+"\nasync function retryBuyerReceiptRepair(){if(busy||sellerBusy)return;let request;try{const response=await fetch(chrome.runtime.getURL('buyer-receipt-repair-request.json'),{cache:'no-store'});request=response.ok?await response.json():null;}catch{return;}const {diagnosticInstance}=await STORE.get('diagnosticInstance');await runBuyerReceiptRepair({request,profileId:diagnosticInstance,storage:STORE,start});}\n";
}
