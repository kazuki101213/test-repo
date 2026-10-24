import {sellerAccounts} from './seller-sync.js?v=0.1.143';
import {sellerQueuedOperations} from './seller-runtime.js?v=0.1.143';

// Called only after a real patrol. Existing claims guard every marketplace
// action; this path can execute shipping_code only, never listing/ship_notice.
export async function processLineShipping(dependencies){
 const {settings,rpc,log}=dependencies,accounts=sellerAccounts(settings);
 if(settings.mode==='diagnostic'||!accounts.length)return;
 const result=await rpc('extension_prepare_line_shipping',{p_account_ids:accounts.map(a=>a.id)});
 const count=Math.min(20,Math.max(0,Number(result?.queued)||0));
 for(let n=0;n<count;n++){
  const operation=await sellerQueuedOperations({...dependencies,onlyAutomaticLine:true});
  if(!operation?.processed)break;
  if(operation.status!=='succeeded')await log('warning','LINE発送依頼：発送コードを取得できない商品があります。アプリの発送画面で確認してください。');
 }
}
