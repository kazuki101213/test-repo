import {useCallback,useEffect,useRef,useState} from 'react';
import {cachedInventoryPage,fetchInventoryPage,mergeInventoryPage,rememberInventoryPage,type InventoryScope,type InventoryPage} from '@bussan/shared';
const filterDebounceMs=450;
const requestDeadlineMs=15_000;
const isStatementTimeout=(cause:unknown)=>typeof cause==='object'&&cause!==null&&'code' in cause&&cause.code==='57014';
const inventoryError=(cause:unknown)=>isStatementTimeout(cause)
 ?'在庫の読み込みに時間がかかっています。もう一度読み込んでください。'
 :cause instanceof Error?cause.message:typeof cause==='object'&&cause!==null&&'message' in cause?String(cause.message):String(cause);

// Filters are serialized: callers can build objects during render without restarting requests.
export function useInventoryPage<T extends {id:string}>(scope:InventoryScope,owner:string,filters:Record<string,unknown>,all=false){
 const serialized=JSON.stringify(filters),key=owner+':'+scope+':'+serialized;
 const [window,setWindow]=useState({key,limit:50});
 const limit=all?10000:window.key===key?window.limit:50;
 const [state,setState]=useState<{key:string;page?:InventoryPage<T>;loading:boolean;error:string|null}>(()=>({key,page:cachedInventoryPage<T>(key),loading:true,error:null}));
 const refreshRef=useRef<()=>Promise<void>>(async()=>{});
 const requestQueue=useRef<Promise<void>>(Promise.resolve());
 useEffect(()=>{
  let active=true,busy=false;
  let page=cachedInventoryPage<T>(key);let lastCheck=0;
  setState({key,page,loading:!page,error:null});
  const refresh=async(force=false)=>{
   if(!active||busy||(!force&&Date.now()-lastCheck<5000))return;
   busy=true;
   const fetchPage=async()=>{
    const controller=new AbortController();
    const deadline=setTimeout(()=>controller.abort(),requestDeadlineMs);
    try {
     return await fetchInventoryPage<T>(scope,JSON.parse(serialized),limit,page?.fingerprints??{},controller.signal);
    }finally{clearTimeout(deadline);}
   };
   // A canceled browser request can leave its database query running. Wait for
   // the current request and skip any queued conditions that are already stale.
   const request=requestQueue.current.then(async()=>{
    if(!active)return;
    try{
     let snapshot;
     try{snapshot=await fetchPage();}
     catch(cause){
      if(!active||!isStatementTimeout(cause))throw cause;
      await new Promise(resolve=>setTimeout(resolve,filterDebounceMs));
      if(!active)return;
      snapshot=await fetchPage();
     }
     if(!active)return;
     if(all&&snapshot.total>10000)throw new Error('対象が多いため、検索条件を絞り込んでください。');
     page={rows:mergeInventoryPage(page?.rows??[],snapshot),fingerprints:snapshot.unchanged?(page?.fingerprints??{}):{...snapshot.fingerprints,...(snapshot.revision?{__revision:snapshot.revision}:{})},total:snapshot.total,limit,checkedAt:Date.now()};
     rememberInventoryPage(key,page);lastCheck=Date.now();setState({key,page,loading:false,error:null});
    }catch(cause){if(active)setState(current=>({...current,key,loading:false,error:inventoryError(cause)}));}
   });
   requestQueue.current=request;
   try{await request;}finally{busy=false;}
  };
  refreshRef.current=()=>refresh(true);
  const visible=()=>{if(document.visibilityState==='visible')void refresh();};
  // Debounce typing, and reuse fingerprints on tab return instead of loading the catalog again.
  const initial=setTimeout(()=>void refresh(true),filterDebounceMs);
  const timer=setInterval(visible,300000);
  windowGlobal().addEventListener('focus',visible);document.addEventListener('visibilitychange',visible);
  return()=>{active=false;clearTimeout(initial);clearInterval(timer);windowGlobal().removeEventListener('focus',visible);document.removeEventListener('visibilitychange',visible);};
 },[key,limit,all]);
 const page=state.key===key?state.page:cachedInventoryPage<T>(key);
 const updateRow=useCallback((row:T)=>{
  const current=cachedInventoryPage<T>(key);if(!current)return;
  // The next diff must revalidate server-derived parent/accessory values after a local save.
  const fingerprints={...current.fingerprints};delete fingerprints[row.id];
  const next={...current,rows:current.rows.map(item=>item.id===row.id?row:item),fingerprints};
  rememberInventoryPage(key,next);setState(s=>s.key===key?({...s,page:next}):s);void refreshRef.current();
 },[key]);
 return {rows:page?.rows??[],total:page?.total??0,hasPage:!!page,more:!all&&(page?.total??0)>limit,loading:state.key!==key||state.loading,error:state.key===key?state.error:null,
 refresh:()=>refreshRef.current(),loadMore:()=>setWindow({key,limit:limit+50}),updateRow};
}
const windowGlobal=()=>globalThis.window;
