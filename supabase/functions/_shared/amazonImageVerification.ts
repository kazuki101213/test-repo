import jpeg from 'npm:jpeg-js@0.4.4';
type Raster={width:number;height:number;data:Uint8Array};
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
async function signature(url:string,amazon:boolean):Promise<Signature>{
 const target=new URL(url);
 if(target.protocol!=='https:'||amazon&&!/(^|\.)(media-amazon\.com|ssl-images-amazon\.com)$/.test(target.hostname))throw Error('Untrusted image source');
 const r=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(10000)});
 if(!r.ok||!r.body||Number(r.headers.get('content-length'))>8*1024*1024)throw Error('Image unavailable');
 const reader=r.body.getReader(),chunks:Uint8Array[]=[];let length=0;
 while(true){const next=await reader.read();if(next.done)break;length+=next.value.length;if(length>8*1024*1024){await reader.cancel();throw Error('Image too large');}chunks.push(next.value);}
 const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
 const decoded=jpeg.decode(bytes,{useTArray:true,maxResolutionInMP:20,maxMemoryUsageInMB:128});
 return photographSignature(decoded);
}
export async function verifyAmazonPhotoCopies(listing:Record<string,any>,images:Record<string,any>,allowLegacyOrder=false):Promise<{verified:boolean;order:number[]}>{
 const originals=Object.entries(images),urls:string[]=[];
 for(const [name] of originals){const values=listing.attributes?.[name.replace('_offer_','_product_')]??[];const found=values.filter((v:any)=>v.marketplace_id==='A1VC38T7YXB528'&&typeof v.media_location==='string');if(found.length!==1)return{verified:false,order:[]};urls.push(found[0].media_location);}
 for(let i=originals.length;i<6;i++){const key=i?'other_product_image_locator_'+i:'main_product_image_locator';if((listing.attributes?.[key]??[]).some((v:any)=>v.marketplace_id==='A1VC38T7YXB528'))return{verified:false,order:[]};}
 try{
  // Decode sequentially to bound memory for full-size phone photographs.
  const source:Signature[]=[];for(const [,values] of originals)source.push(await signature(values[0].media_location,false));
  const order:number[]=[];
  for(let i=0;i<urls.length;i++){const copy=await signature(urls[i],true),matches=source.flatMap((s,index)=>samePhotograph(s,copy)?[index]:[]);if(allowLegacyOrder){if(matches.length!==1||order.includes(matches[0]))return{verified:false,order:[]};order.push(matches[0]);}else{if(!matches.includes(i))return{verified:false,order:[]};order.push(i);}}
  return{verified:true,order};
 }catch{return{verified:false,order:[]};}
}
