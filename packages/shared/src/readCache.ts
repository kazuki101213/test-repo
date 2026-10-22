/** Bounded, in-memory read cache. Never stores credentials or survives a reload. */
export class ReadCache {
 private values=new Map<string,{value:unknown;until:number}>();
 private pending=new Map<string,Promise<unknown>>();
 private epoch=0;
 constructor(private now:()=>number=Date.now,private limit=32){}
 async read<T>(user:string,key:string,ttl:number,load:()=>Promise<T>):Promise<T>{
  const id=JSON.stringify([user,key]),old=this.values.get(id);
  if(old&&old.until>this.now()){this.values.delete(id);this.values.set(id,old);return old.value as T;}
  this.values.delete(id);
  const running=this.pending.get(id);if(running)return running as Promise<T>;
  const epoch=this.epoch;
  const request=Promise.resolve().then(load).then(value=>{
   if(epoch===this.epoch&&ttl>0){this.values.set(id,{value,until:this.now()+ttl});while(this.values.size>this.limit)this.values.delete(this.values.keys().next().value!);}
   return value;
  });
  this.pending.set(id,request);
  try{return await request;}finally{if(this.pending.get(id)===request)this.pending.delete(id);}
 }
 invalidate(prefix?:string){
  this.epoch++;
  for(const map of [this.values,this.pending])for(const key of map.keys())if(!prefix||String(JSON.parse(key)[1]).startsWith(prefix))map.delete(key);
 }
}
export const sharedReadCache=new ReadCache();
export const invalidateReadCache=(prefix?:string)=>sharedReadCache.invalidate(prefix);
