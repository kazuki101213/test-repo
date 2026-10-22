const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),assert=require('node:assert/strict');
const load=(file,modules={},extra={})=>{const c={exports:{},require:id=>modules[id]??{},...extra};vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,c);return c.exports;};
const pure=load('packages/shared/src/readCache.ts');const photos=load('packages/shared/src/photoUrlCache.ts');
(async()=>{
 let now=0,n=0;const cache=new pure.ReadCache(()=>now,2),read=()=>{n++;return Promise.resolve({n});};
 const first=await cache.read('one','staff',30,read);assert.equal(await cache.read('one','staff',30,read),first);assert.equal(n,1);
 await cache.read('two','staff',30,read);assert.equal(n,2);now=31;await cache.read('one','staff',30,read);assert.equal(n,3);
 let release;const slow=()=>{n++;return new Promise(r=>release=r);};
 const a=cache.read('one','slow',30,slow),b=cache.read('one','slow',30,slow);await Promise.resolve();release('old');assert.equal(await a,'old');assert.equal(await b,'old');assert.equal(n,4);
 const stale=cache.read('one','mutation',30,slow);await Promise.resolve();cache.invalidate('mutation');release('stale');await stale;
 await cache.read('one','mutation',30,read);assert.equal(n,6,'An in-flight read cannot refill the cache after invalidation');
 let fails=0;for(let i=0;i<2;i++)await assert.rejects(cache.read('one','bad',30,async()=>{fails++;throw Error('offline');}),/offline/);assert.equal(fails,2);
 await cache.read('one','bounded-a',30,read);await cache.read('one','bounded-b',30,read);const before=n;await cache.read('one','mutation',30,read);assert.equal(n,before+1,'Bounded cache evicts old values');
 const image=(id,token,canDelete=true)=>({id,url:'https://storage.test/'+id+'?token='+token,canDelete});
 assert.equal(photos.stablePhotoUrls('one',[image('a','first')],0)[0].url,image('a','first').url);
 const fresh=photos.stablePhotoUrls('one',[image('a','new',false),image('b','new')],1);assert.equal(fresh[0].url,image('a','first').url);assert.equal(fresh[0].canDelete,false);assert.equal(fresh.length,2);
 assert.equal(photos.stablePhotoUrls('one',[image('b','third')],2).length,1,'Deleted photo IDs never reappear');
 assert.equal(photos.stablePhotoUrls('two',[image('a','other')],2)[0].url,image('a','other').url);
 assert.equal(photos.stablePhotoUrls('one',[image('a','expired')],300001)[0].url,image('a','expired').url);
 photos.clearPhotoUrlCache();assert.equal(photos.stablePhotoUrls('one',[image('a','after-clear')],300002)[0].url,image('a','after-clear').url);
 let user='one',requests=0,photoRequests=0,token=0,dbPhotos=['a'],failDelete=false,staffRequests=0,productRequests=[];
 const sb={auth:{getSession:async()=>({data:{session:user?{user:{id:user}}:null},error:null})},functions:{invoke:async(name,{body})=>{
  requests++;if(body.action==='list'){photoRequests++;return{data:{photos:dbPhotos.map(id=>image(id,String(++token)))}};}
  if(name==='delivery-photo-delete'){dbPhotos=['b'];return failDelete?{error:new Error('partial failure')}:{data:{deleted:true}};}
  return{data:{added:1,total:2,sourceSerial:'1'}};
 }},from:table=>{if(table==='products'){let id;return{select(){return this;},eq(key,value){if(key==='id'){id=value;productRequests.push(value);}return this;},maybeSingle:async()=>({data:{id,asin:'B000000001'},error:null})};}return{select(){return this;},eq(){return this;},order:async()=>{staffRequests++;return{data:[{id:'worker'}],error:null};}};}};
 const session=load('packages/shared/src/sessionReads.ts',{'./supabase':{getSupabase:()=>sb},'./readCache':pure});
 const shared={getSupabase:()=>sb,...session,...pure,...photos};
 const delivery=load('apps/delivery/src/api.ts',{'@bussan/shared':shared});
 const admin=load('apps/admin/src/api.ts',{'@bussan/shared':shared});
 await Promise.all([admin.fetchStaff(),admin.fetchStaff()]);await admin.fetchStaff();assert.equal(staffRequests,1,'Concurrent and recent master reads share one authenticated request');
 await admin.fetchProduct('chosen');assert.deepEqual(productRequests,['chosen']);
 const old=await delivery.fetchPhotoUrls('item');const again=await delivery.fetchPhotoUrls('item');assert.equal(photoRequests,2,'Photo membership is checked fresh on every open');assert.equal(old[0].url,again[0].url);
 dbPhotos=['b'];assert.equal((await delivery.fetchPhotoUrls('item'))[0].id,'b','Added/deleted IDs are immediately reflected');
 await delivery.deletePhoto('a');const after=await delivery.fetchPhotoUrls('item');assert.notEqual(after[0].url,again[0].url);
 failDelete=true;await assert.rejects(delivery.deletePhoto('b'),/partial failure/);const refreshed=await delivery.fetchPhotoUrls('item');assert.notEqual(refreshed[0].url,after[0].url,'Even partially failed photo changes invalidate display URLs');
 user='two';await admin.fetchStaff();assert.equal(staffRequests,2,'User switch does not share master data');
 user=null;await assert.rejects(delivery.fetchPhotoUrls('item'),/ログイン/);await assert.rejects(admin.fetchStaff(),/ログイン/);
 pure.invalidateReadCache();photos.clearPhotoUrlCache();user='one';await admin.fetchStaff();assert.equal(staffRequests,3,'Cleared login state cannot return a prior cached entry');
 console.log('PASS: exact product ID; bounded auth-scoped cache, expiry/concurrency/failure/invalidation; fresh photo metadata and stable immutable URLs');
})().catch(e=>{console.error(e);process.exitCode=1;});
