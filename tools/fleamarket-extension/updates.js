import {LOADED_BUILD} from './build.js';
export {LOADED_BUILD};
export async function checkPackageUpdate({runtime,storage,fetchFile,busy=()=>false,record=async()=>{}}){
 if(busy()||(await storage.get('job')).job)return false;
 let marker;try{const response=await fetchFile(runtime.getURL('reload-marker.json')+'?t='+Date.now(),{cache:'no-store',signal:AbortSignal.timeout(5000)});if(!response.ok)return false;const text=await response.text();if(text.length>4096)return false;marker=JSON.parse(text);}catch{return false;}
 if(marker?.ready!==true||!/^\d+\.\d+\.\d+$/.test(marker.version||'')||!/^[a-f0-9-]{36}$/.test(marker.revision||''))return false;
 const {lastHandledReloadRequest}=await storage.get('lastHandledReloadRequest');
 if(marker.requestId&&!/^[a-f0-9-]{36}$/.test(marker.requestId))return false;
 const requested=!!marker.requestId&&marker.requestId!==lastHandledReloadRequest;
 if(!requested&&marker.version===runtime.getManifest().version&&marker.revision===LOADED_BUILD)return false;
 if(busy()||(await storage.get('job')).job)return false;
 await record('info','SSHで配置された更新を再読み込みします',{nextVersion:marker.version});
 if(marker.requestId)await storage.set({lastHandledReloadRequest:marker.requestId});
 await storage.set({lastReloadRequest:{at:new Date().toISOString(),version:marker.version,revision:marker.revision}});
 runtime.reload();return true;
}
