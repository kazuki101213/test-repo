export function installDispatchDays(source){
 if(source.includes("from './dispatch-days.js'"))return source;
 const hook=source.includes('  if(await runDailyPriceReduction(')?'  if(await runDailyPriceReduction(':'  if(checkQueues){';
 if(!source.includes(hook))throw Error('seller idle hook missing');
 const run="  if(await runDispatchDaysUpdate({...dependencies,records,profileId:records.diagnosticInstance,continueWork:async active=>{if(active)await chrome.alarms.create('fm:dispatch-days-work',{when:Date.now()+60000});else await chrome.alarms.clear('fm:dispatch-days-work');},fetchRequest:async()=>{try{const response=await fetch(chrome.runtime.getURL('dispatch-days-request.json'),{cache:'no-store'});return response.ok?await response.json():null;}catch{return null;}}}))return;\n";
 return "import {runDispatchDaysUpdate} from './dispatch-days.js';\n"+source.replace(hook,run+hook);
}
export function installDispatchDaysSession(source){
 if(source.includes("from './dispatch-days.js'"))return source;
 const hook='return {go,loaded,';if(!source.includes(hook))throw Error('seller session hook missing');
 return "import {mercariDispatchDaysPage} from './dispatch-days.js';\n"+source.replace(hook,'return {go,loaded,dispatchDays:args=>execute(mercariDispatchDaysPage,args),');
}
