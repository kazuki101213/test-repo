export function installDailyPrice(source){
 if(source.includes("from './daily-price.js'"))return source;
 const hook='  if(checkQueues){';if(!source.includes(hook))throw Error('seller idle hook missing');
 return "import {runDailyPriceReduction,ensurePriceAlarm,PRICE_POLICY} from './daily-price.js';\n"+source.replace('await ensureAlarms(chrome.alarms,await getSettings(),','await ensurePriceAlarm(chrome.alarms,await getSettings());await STORE.set({repricingPolicy:PRICE_POLICY,repricingAlarm:await chrome.alarms.get(\'fm:price\')||null});await ensureAlarms(chrome.alarms,await getSettings(),').replace(hook,"  if(await runDailyPriceReduction({...dependencies,records,profileId:records.diagnosticInstance,continueWork:async active=>{const old=await chrome.alarms.get('fm:price-work');if(active&&!old)await chrome.alarms.create('fm:price-work',{when:Date.now()+60000});if(!active&&old)await chrome.alarms.clear('fm:price-work');},fetchInspection:async()=>{try{const response=await fetch(chrome.runtime.getURL('price-inspection-request.json'),{cache:'no-store'});return response.ok?await response.json():null;}catch{return null;}}}))return;\n"+hook);
}
export function installPriceSession(source){
 if(source.includes("from './daily-price.js'"))return source;
 const hook='return {go,loaded,buyerListEvidence:';if(!source.includes(hook))throw Error('seller session hook missing');
 return "import {mercariPricePage,mercariPriceResult} from './daily-price.js';\n"+source.replace(hook,"return {go,loaded,price:args=>execute(mercariPricePage,args),priceResult:args=>execute(mercariPriceResult,args),buyerListEvidence:");
}
