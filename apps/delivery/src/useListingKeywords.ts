import { useEffect, useRef, useState } from 'react';
import { generateListingKeywords } from './api';
import { appendListingKeywords } from './listingKeywords';

type Input={ itemId:string; target:'amazon'|'mercari'|'yahoo-auction'; title:string; body:string; category:string; manufacturer:string; sku:string; disabled:boolean; apply:(body:string)=>void };
const pending=new Map<string,Promise<Awaited<ReturnType<typeof generateListingKeywords>>>>();
export function useListingKeywords(input:Input){
 const [busy,setBusy]=useState(false),[message,setMessage]=useState('');
 const signature=JSON.stringify([input.itemId,input.target,input.title,input.category,input.manufacturer]);
 const latest=useRef({input,signature});latest.current={input,signature};
 const mounted=useRef(true);
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
 async function generate(force=false){
  const snapshot=latest.current;
  const value={...snapshot.input};
  if(value.target==='amazon'||value.disabled||!value.title.trim()||!value.category)return;
  setBusy(true);setMessage('');
  const key=snapshot.signature;
  let request=pending.get(key);
  if(!request){
   request=generateListingKeywords({itemId:value.itemId,target:value.target,title:value.title,category:value.category,manufacturer:value.manufacturer,force});
   pending.set(key,request);
   void request.finally(()=>{if(pending.get(key)===request)pending.delete(key);}).catch(()=>{});
  }
  try{
   const result=await request;
   if(!mounted.current||latest.current.signature!==snapshot.signature)return;
   if(latest.current.input.body!==value.body||latest.current.input.disabled){setMessage('生成しました。編集中の文章は変更していません。反映する場合はもう一度生成してください。');return;}
   const next=appendListingKeywords(value.body,result.keywords,result.previous,value.sku);
   if(next.length>5000){setMessage('文字数の上限を超えるため追加できません。説明文を短くしてください。');return;}
   if(next!==value.body)latest.current.input.apply(next);
  }catch(error){if(mounted.current&&latest.current.signature===snapshot.signature)setMessage(error instanceof Error?error.message:'AI生成できませんでした。');}
  finally{if(mounted.current&&latest.current.signature===snapshot.signature)setBusy(false);}
 }
 useEffect(()=>{
  setBusy(false);setMessage('');
  if(input.target==='amazon'||!input.body.includes('AI生成による検索用'))return;
  // Debounce product name edits. Reopening uses the server cache; no page refreshes.
  const timer=window.setTimeout(()=>void generate(),800);
  return()=>window.clearTimeout(timer);
 },[signature]);
 return {busy,message,generate};
}
