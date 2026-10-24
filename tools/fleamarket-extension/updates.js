import {LOADED_BUILD} from './build.js';
export {LOADED_BUILD};
export async function checkPackageUpdate({runtime,storage,fetchFile,busy=()=>false,record=async()=>{},expectedBuild=null,requestId=null}){
 if(busy()||(await storage.get('job')).job)return false;
 let marker;try{const response=await fetchFile(runtime.getURL('reload-marker.json')+'?t='+Date.now(),{cache:'no-store',signal:AbortSignal.timeout(5000)});if(!response.ok)return false;const text=await response.text();if(text.length>4096)return false;marker=JSON.parse(text);}catch{return false;}
 if(marker?.ready!==true||!/^\d+\.\d+\.\d+$/.test(marker.version||'')||!/^[a-f0-9-]{36}$/.test(marker.revision||''))return false;
 if(expectedBuild&&marker.revision!==expectedBuild||requestId&&!/^[a-f0-9-]{36}$/.test(requestId))return false;
 const {lastHandledReloadRequest}=await storage.get('lastHandledReloadRequest');
 if(requestId&&requestId===lastHandledReloadRequest)return false;
 if(marker.requestId&&!/^[a-f0-9-]{36}$/.test(marker.requestId))return false;
 const reloadRequestId=requestId||marker.requestId,requested=!!reloadRequestId&&reloadRequestId!==lastHandledReloadRequest;
 if(!requested&&marker.version===runtime.getManifest().version&&marker.revision===LOADED_BUILD)return false;
 if(busy()||(await storage.get('job')).job)return false;
 await record('info','SSHで配置された更新を再読み込みします',{nextVersion:marker.version});
 if(reloadRequestId)await storage.set({lastHandledReloadRequest:reloadRequestId});
 await storage.set({lastReloadRequest:{at:new Date().toISOString(),version:marker.version,revision:marker.revision}});
 runtime.reload();return true;
}
// Explicit local SSH request only; uses the existing idle file read, not another timer.
export async function checkRequestedPackageUpdate({request,profileId,now=Date.now(),...args}){
 const uuid=value=>typeof value==='string'&&/^[a-f0-9-]{36}$/.test(value);
 if(request?.kind!=='package-update'||!uuid(request.id)||!uuid(request.expectedBuild)||request.expectedBuild===LOADED_BUILD||!Array.isArray(request.profiles)||request.profiles.length<1||request.profiles.length>3||!request.profiles.every(uuid)||!request.profiles.includes(profileId))return false;
 const issued=Date.parse(request.issuedAt),expires=Date.parse(request.expiresAt);
 if(!Number.isFinite(issued)||!Number.isFinite(expires)||issued>now||expires<=now||expires-issued<=0||expires-issued>15*60000)return false;
 return checkPackageUpdate({...args,expectedBuild:request.expectedBuild,requestId:request.id});
}
