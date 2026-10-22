import {useCallback,useEffect,useRef,useState} from 'react';
import {fetchPurchaseSync,requestPurchaseSync,purchaseSyncSummary,type PurchaseSyncStatus} from '../purchaseSync';
export function usePurchaseSync(refreshList: () => Promise<void>, enabled = true) {
 const [status,setStatus]=useState<PurchaseSyncStatus|null>(null),[requesting,setRequesting]=useState(false),[error,setError]=useState<string|null>(null);
 const locked=useRef(false),last=useRef(''),mounted=useRef(true),revision=useRef(0),checking=useRef(false);
 const accept=useCallback(async(value: PurchaseSyncStatus)=>{if(!mounted.current)return;setStatus(value);const summary=purchaseSyncSummary(value);if(last.current!==summary.fingerprint){last.current=summary.fingerprint;await refreshList();}},[refreshList]);
 const check=useCallback(async()=>{if(checking.current)return;checking.current=true;const current=revision.current;try{const value=await fetchPurchaseSync();if(mounted.current&&current===revision.current){setError(null);await accept(value);}}catch(e){if(mounted.current&&current===revision.current)setError((e as {message?:string}).message||'同期状況を確認できません。画面を再読み込みして確認してください。');}finally{checking.current=false;}},[accept]);
 useEffect(()=>{mounted.current=true;if(!enabled)return;void check();const focus=()=>void check();window.addEventListener('focus',focus);return()=>{mounted.current=false;window.removeEventListener('focus',focus);};},[check,enabled]);
 const summary=purchaseSyncSummary(status);
 useEffect(()=>{if(!summary.active)return;const timer=window.setInterval(()=>void check(),10000);return()=>window.clearInterval(timer);},[summary.active,check]);
 const startSync=useCallback(async()=>{if(!enabled||locked.current||purchaseSyncSummary(status).active)return;locked.current=true;revision.current++;setRequesting(true);setError(null);try{await accept(await requestPurchaseSync(crypto.randomUUID()));}catch(e){setError((e as {message?:string}).message||'同期を依頼できませんでした。');}finally{locked.current=false;if(mounted.current)setRequesting(false);}},[accept,status,enabled]);
 return {startSync,syncing:requesting||summary.active,message:requesting?'購入履歴の同期を依頼しています…':summary.message,error};
}
