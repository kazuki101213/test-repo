import decode,{init} from 'npm:@jsquash/jpeg@1.6.0/decode.js';
type Raster={width:number;height:number;data:Uint8Array|Uint8ClampedArray};
type Signature={ratio:number;pixels:number[]};
export function photographSignature(image:Raster):Signature{
 const pixels:number[]=[];
 for(let by=0;by<16;by++)for(let bx=0;bx<16;bx++){
  const sum=[0,0,0];
  for(let sy=0;sy<8;sy++)for(let sx=0;sx<8;sx++){
   const x=Math.min(image.width-1,Math.floor((bx+(sx+.5)/8)*image.width/16)),y=Math.min(image.height-1,Math.floor((by+(sy+.5)/8)*image.height/16)),offset=(y*image.width+x)*4;
   for(let c=0;c<3;c++)sum[c]+=image.data[offset+c];
  }
  pixels.push(...sum.map(v=>v/64));
 }
 return{ratio:image.width/image.height,pixels};
}
export function samePhotograph(a:Signature,b:Signature):boolean{
 if(Math.abs(a.ratio/b.ratio-1)>.02||a.pixels.length!==768||b.pixels.length!==768)return false;
 const differences=a.pixels.map((v,i)=>Math.abs(v-b.pixels[i]));
 return differences.reduce((s,v)=>s+v,0)/differences.length<=8&&differences.filter(v=>v>30).length/differences.length<=.02;
}
const decoderUrl='https://cdn.jsdelivr.net/npm/@jsquash/jpeg@1.6.0/codec/dec/mozjpeg_dec.wasm';
const decoderHash='a7c4b12169817e779ff4af137981393ae924944e167ad1bd95747c9199162d3e';
let ready:Promise<void>|undefined;
const signatures=new Map<string,Signature>();
export async function prepareImageDecoder(){
 if(!ready)ready=(async()=>{
  const response=await fetch(decoderUrl,{redirect:'error',signal:AbortSignal.timeout(10000)});
  if(!response.ok)throw Error('Image decoder unavailable');
  const bytes=await response.arrayBuffer();
  const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(v=>v.toString(16).padStart(2,'0')).join('');
  if(bytes.byteLength>1024*1024||hash!==decoderHash)throw Error('Unverified image decoder');
  await init(await WebAssembly.compile(bytes));
 })().catch(error=>{ready=undefined;throw error;});
 await ready;
}
export function validateJpegDimensions(bytes:Uint8Array){
 if(bytes[0]!==255||bytes[1]!==216)throw Error('Unsupported image');
 for(let p=2;p<bytes.length;){
  if(bytes[p++]!==255)throw Error('Invalid JPEG');
  while(bytes[p]===255)p++;
  const marker=bytes[p++];
  if(marker===217||marker===218)break;
  if(marker===1||marker>=208&&marker<=215)continue;
  const length=(bytes[p]<<8)|bytes[p+1];
  if(length<2||p+length>bytes.length)throw Error('Truncated JPEG');
  if(marker>=192&&marker<=207&&![196,200,204].includes(marker)){
   const height=(bytes[p+3]<<8)|bytes[p+4],width=(bytes[p+5]<<8)|bytes[p+6];
   if(length<8||!width||!height||width*height>20_000_000)throw Error('Image dimensions exceed limit');
   return;
  }
  p+=length;
 }
 throw Error('JPEG dimensions missing');
}
export function amazonComparisonImageUrl(raw:string):string{
 const target=new URL(raw);
 if(target.protocol!=='https:'||!/(^|\.)(media-amazon\.com|ssl-images-amazon\.com)$/.test(target.hostname))throw Error('Untrusted image source');
 const match=target.pathname.match(/^\/images\/I\/([^.\/]+)(?:\.[^\/]*)?\.jpe?g$/i);
 if(match){target.pathname='/images/I/'+match[1]+'._SL256_.jpg';target.search='';}
 return target.href;
}
async function signature(url:string,amazon:boolean,fetcher:typeof fetch):Promise<Signature>{
 if(amazon)url=amazonComparisonImageUrl(url);
 const target=new URL(url);
 if(target.protocol!=='https:'||amazon&&!/(^|\.)(media-amazon\.com|ssl-images-amazon\.com)$/.test(target.hostname))throw Error('Untrusted image source');
 const key=target.origin+target.pathname;
 const cached=signatures.get(key);if(cached)return cached;
 const r=await fetcher(url,{redirect:'error',signal:AbortSignal.timeout(10000)});
 if(!r.ok||!r.body||Number(r.headers.get('content-length'))>8*1024*1024)throw Error('Image unavailable');
 const reader=r.body.getReader(),chunks:Uint8Array[]=[];let length=0;
 while(true){const next=await reader.read();if(next.done)break;length+=next.value.length;if(length>8*1024*1024){await reader.cancel();throw Error('Image too large');}chunks.push(next.value);}
 const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
 validateJpegDimensions(bytes);
 await prepareImageDecoder();
 const decoded=await decode(bytes.buffer as ArrayBuffer,{preserveOrientation:false});
 const result=photographSignature(decoded);
 if(signatures.size>=24)signatures.delete(signatures.keys().next().value!);
 signatures.set(key,result);
 return result;
}
export async function verifyAmazonPhotoCopies(listing:Record<string,any>,images:Record<string,any>,allowLegacyOrder=false,fetcher:typeof fetch=fetch):Promise<{verified:boolean;order:number[]}>{
 const originals=Object.entries(images),urls:string[]=[];
 for(const [name] of originals){const values=listing.attributes?.[name.replace('_offer_','_product_')]??[];const found=values.filter((v:any)=>v.marketplace_id==='A1VC38T7YXB528'&&typeof v.media_location==='string');if(found.length!==1)return{verified:false,order:[]};urls.push(found[0].media_location);}
 for(let i=originals.length;i<6;i++){const key=i?'other_product_image_locator_'+i:'main_product_image_locator';if((listing.attributes?.[key]??[]).some((v:any)=>v.marketplace_id==='A1VC38T7YXB528'))return{verified:false,order:[]};}
 try{
  // Decode sequentially to bound memory for full-size phone photographs.
  const source:Signature[]=[];for(const [,values] of originals)source.push(await signature(values[0].media_location,false,fetcher));
  const order:number[]=[];
  for(let i=0;i<urls.length;i++){const copy=await signature(urls[i],true,fetcher),matches=source.flatMap((s,index)=>samePhotograph(s,copy)?[index]:[]);if(allowLegacyOrder){if(matches.length!==1||order.includes(matches[0]))return{verified:false,order:[]};order.push(matches[0]);}else{if(!matches.includes(i))return{verified:false,order:[]};order.push(i);}}
  return{verified:true,order};
 }catch{return{verified:false,order:[]};}
}
