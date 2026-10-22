// Metadata is always fetched fresh; reuse only an immutable file's still-valid display URL.
const urls=new Map<string,{url:string;until:number}>();
export function stablePhotoUrls<T extends {id:string;url:string}>(user:string,photos:T[],now=Date.now()):T[]{
 for(const [key,value] of urls)if(value.until<=now)urls.delete(key);
 return photos.map(photo=>{
  const key=JSON.stringify([user,photo.id,photo.url.split('?')[0]]),old=urls.get(key);
  if(old&&old.until>now)return {...photo,url:old.url};
  urls.set(key,{url:photo.url,until:now+300000});
  while(urls.size>500)urls.delete(urls.keys().next().value!);
  return photo;
 });
}
export const clearPhotoUrlCache=()=>urls.clear();
