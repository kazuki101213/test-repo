// Cache immutable receipt file bytes only; each reader owns and releases its own object URL.
const limit=32*1024*1024;
const cache=new Map<string,{blob:Blob;at:number}>();
const pending=new Map<string,Promise<Blob>>();
let bytes=0;
export async function cachedReceiptBlob(user:string,path:string,download:()=>Promise<Blob>):Promise<Blob>{
 const key=JSON.stringify([user,path]);const old=cache.get(key);
 if(old&&Date.now()-old.at<300000){cache.delete(key);cache.set(key,old);return old.blob;}
 if(old){cache.delete(key);bytes-=old.blob.size;}
 const running=pending.get(key);if(running)return running;
 const request=download().then(blob=>{
  if(blob.size<=limit){
   for(const [id,value] of cache){if(Date.now()-value.at>=300000){bytes-=value.blob.size;cache.delete(id);}}
   while(bytes+blob.size>limit&&cache.size){const id=cache.keys().next().value!;bytes-=cache.get(id)!.blob.size;cache.delete(id);}
   cache.set(key,{blob,at:Date.now()});bytes+=blob.size;
  }
  return blob;
 });
 pending.set(key,request);try{return await request;}finally{pending.delete(key);}
}
