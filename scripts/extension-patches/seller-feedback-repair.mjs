export function installSellerFeedbackRepair(source){
 if(source.includes("from './seller-feedback-repair.js'"))return source;
 const hook='if(await runSellerSaleRepair(',i=source.indexOf(hook),end=source.indexOf('return;',i)+7;if(i<0||end<7)throw Error('manual repair hook missing');
 return "import {runSellerFeedbackRepair} from './seller-feedback-repair.js';\n"+source.slice(0,end)+'\n  '+source.slice(i,end).replace('runSellerSaleRepair','runSellerFeedbackRepair')+source.slice(end);
}
