const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('../../../node_modules/typescript');
const itemId = '00000000-0000-0000-0000-000000000002';
function setup({ many = false, assigned = true, role = 'deliverer' } = {}) {
  const state = {
    profiles: [{ user_id:'user', staff_id:'staff' }],
    staff: [{ id:'staff', role, is_active:true }],
    items: [{id:'original',lot_seq:123,deliverer_id:'other'}, {id:itemId,lot_seq:123,deliverer_id:assigned ? 'staff' : 'other'}, {id:'unrelated',lot_seq:999}],
    item_photos: many ? Array.from({length:1001},(_,i)=>({id:'p'+i,item_id:'original',storage_path:'photos/'+i,drive_file_id:null,uploaded_by:'other'})) : [
      {id:'p1',item_id:'original',storage_path:'photos/old.jpg',drive_file_id:'old-file',uploaded_by:'other'},
      {id:'p2',item_id:itemId,storage_path:'photos/new.jpg',drive_file_id:null,uploaded_by:'staff'},
      {id:'p3',item_id:'unrelated',storage_path:'photos/unrelated.jpg',drive_file_id:null,uploaded_by:'staff'},
    ],
    lot_photo_folders:[{lot_seq:123,drive_folder_id:'shared'}],
    photo_reviews:[{item_id:'original',drive_folder_id:'old-folder',approved_at:'approved',exported_photo_count:1}],
    google:[], downloads:[], signed:[], notices:[], copies:[], mediaFailure:null,
  };
  const service = {
    async rpc(name,args){
      if(name==='record_reflected_product_photo') {
        const target=state.items.find(row=>row.id===args.p_item_id);
        const storage_path=target.sku+'/reflected-'+args.p_source_photo_id+'.jpg';
        if(!state.item_photos.some(row=>row.item_id===target.id&&row.storage_path===storage_path))state.item_photos.push({id:'copy-'+args.p_source_photo_id,item_id:target.id,storage_path,uploaded_by:args.p_staff_id,photo_kind:'product',drive_file_id:null,created_at:new Date().toISOString()});
        return {error:null};
      }
      assert.equal(name,'record_packing_photo_notice');state.notices.push(args);return {error:null};
    },
    auth:{getUser:async()=>({data:{user:{id:'user'}}})},
    from(table) {
      const filters=[]; let from=0,to=Infinity, mutation=null;
      const q={select(){return q},eq(key,value){filters.push(row=>row[key]===value);return q},in(key,values){filters.push(row=>values.includes(row[key]));return q},order(){return q},range(a,b){from=a;to=b;return q},maybeSingle(){return run(true)},single(){return run(true)},
        update(values){mutation={kind:'update',values};return q},upsert(values,options){mutation={kind:'upsert',values,options};return q},then(resolve,reject){return run(false).then(resolve,reject)}};
      async function run(single) {
        let rows=state[table].filter(row=>filters.every(filter=>filter(row)));
        if(mutation?.kind==='update') rows.forEach(row=>Object.assign(row,mutation.values));
        if(mutation?.kind==='upsert') {
          const key=mutation.options?.onConflict || 'item_id';
          const existing=state[table].find(row=>row[key]===mutation.values[key]);
          if(existing && !mutation.options?.ignoreDuplicates) Object.assign(existing,mutation.values);
          else if(!existing) state[table].push({...mutation.values});
        }
        rows=rows.slice(from,to+1);
        return {data:single ? rows[0] || null : rows,error:null};
      }
      return q;
    },
    storage:{from(){return {
      async createSignedUrls(paths){state.signed.push(...paths);return {data:paths.map(path=>({signedUrl:'https://photos.invalid/'+path})),error:null}},
      async download(path){state.downloads.push(path);return {data:new Blob(['image']),error:null}},
      async upload(path,blob){state.copies.push({path,size:blob.size});return {error:null}},
    }}},
  };
  const fetch = async (url, init={}) => {
    state.google.push({url:String(url),...init});
    if(String(url).includes('oauth2')) return Response.json({access_token:'test-token'});
    if(String(url).includes('alt=media')) return String(url).includes(state.mediaFailure??'NEVER') ? new Response('',{status:404}) : new Response(new Blob(['image'],{type:'image/jpeg'}));
    if(String(url).includes('/upload/drive/')) return new Response('{}',{headers:{Location:'https://www.googleapis.com/upload/session'}});
    if(String(url).includes('/upload/session')) return Response.json({id:'new-file'});
    if(String(url).includes('/files/shared?') && !init.method) return Response.json({id:'shared',name:'old-sku'});
    if(String(url).includes('/files/new-file?') && !init.method) return Response.json({id:'new-file',parents:['shared']});
    if(String(url).includes('/files/old-file?') && !init.method) return Response.json({id:'old-file',parents:['old-folder']});
    if(String(url).includes('/files?') && !init.method) return Response.json({files:[]});
    if(init.method==='PATCH') return Response.json({id:'patched'});
    throw new Error('Unexpected Google operation '+url);
  };
  let code=ts.transpileModule(fs.readFileSync(__dirname+'/index.ts','utf8').replace('if (import.meta.main) Deno.serve(handler);',''),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const module={exports:{}};
  new Function('require','module','exports','Deno','fetch',code)(()=>({createClient:()=>service}),module,module.exports,{env:{get:name=>name}},fetch);
  const call=(action,body={})=>module.exports.handler(new Request('https://function.invalid/',{method:'POST',headers:{authorization:'Bearer test','Content-Type':'application/json'},body:JSON.stringify({itemId,action,...body})}));
  return {state,call};
}
test('return lists all original and return photos in its lot, without Drive writes',async()=>{
  const {state,call}=setup(); const response=await call('list');
  assert.equal(response.status,200);
  const body=await response.json();
  assert.deepEqual(body.photos.map(p=>p.id),['p1','p2']);
  assert.deepEqual(body.photos.map(p=>p.canDelete),[false,true]);
  assert.equal(state.google.length,0);
});

test('photos from separate related-item batches are displayed in addition order',async()=>{
  const {state,call}=setup();
  state.items.push(...Array.from({length:101},(_,n)=>({id:'member-'+n,lot_seq:123})));
  state.item_photos=[
    {id:'last',item_id:'original',storage_path:'last.jpg',created_at:'2026-10-17T02:00:00Z'},
    {id:'first',item_id:'member-100',storage_path:'first.jpg',created_at:'2026-10-17T01:00:00Z'},
    {id:'middle',item_id:itemId,storage_path:'middle.jpg',created_at:'2026-10-17T01:30:00Z'},
  ];
  const response=await call('list');assert.equal(response.status,200);
  assert.deepEqual((await response.json()).photos.map(photo=>photo.id),['first','middle','last']);
  assert.equal(state.google.length,0);
});
test('save reuses lot folder, moves older file and uploads every new photo',async()=>{
  const {state,call}=setup(); const response=await call('save');
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{folderId:'shared',added:1,total:2});
  assert.deepEqual(state.downloads,['photos/new.jpg']);
  assert(state.google.some(req=>req.method==='PATCH' && req.url.includes('addParents=shared') && req.url.includes('removeParents=old-folder')));
  const rename=state.google.find(req=>req.method==='PATCH' && req.url.includes('/files/shared?'));
  assert.equal(JSON.parse(rename.body).name,'123');
  assert.equal(state.photo_reviews.find(r=>r.item_id==='original').approved_at,'approved');
  assert.equal(state.photo_reviews.find(r=>r.item_id===itemId).exported_photo_count,1);
  assert.equal(state.item_photos[2].drive_file_id,null);
});
test('all photos beyond the transport row limit are included',async()=>{
  const {state,call}=setup({many:true});const response=await call('list');
  assert.equal((await response.json()).photos.length,1001);
  assert.equal(state.signed.length,1001);
});
test('unassigned deliverer cannot read or save another lot',async()=>{
  const {state,call}=setup({assigned:false});
  assert.equal((await call('list')).status,403);
  assert.equal((await call('save')).status,403);
  assert.equal(state.google.length,0);
});
test('purchaser retains read permission but cannot save unassigned item',async()=>{
  const {call}=setup({assigned:false,role:'purchaser'});
  assert.equal((await call('list')).status,200);
  assert.equal((await call('save')).status,403);
});

test('explicit sales channel wins over old description and working return fallback',()=>{
  const path=__dirname+'/../../../apps/delivery/src/components/DescriptionEditor.tsx';
  const source=fs.readFileSync(path,'utf8');
  const ast=ts.createSourceFile(path,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  const fn=ast.statements.find(node=>ts.isFunctionDeclaration(node) && node.name?.text==='initialTarget');
  assert(fn);
  const code=ts.transpileModule(fn.getText(ast),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
  const initialTarget=new Function(code+'; return initialTarget;')();
  assert.equal(initialTarget({marketplace:'動作品Amazon返品',sales_channel:'FBA'}),'mercari');
  assert.equal(initialTarget({marketplace:'動作品Amazon返品',sales_channel:'ヤフオク'}),'yahoo-auction');
  assert.equal(initialTarget({marketplace:'Amazon返品',sales_channel:'FBA'}),'amazon');
  assert.equal(initialTarget({sales_channel:'ヤフオク',description:'商品名（メルカリ）'}),'yahoo-auction');
  assert.equal(initialTarget({sales_channel:'メルカリ',description:'商品名（ヤフオク）'}),'mercari');
  assert.equal(initialTarget({marketplace:'ヤフオク',sales_channel:'ヤフオク'}),'yahoo-auction');
});

test('packing evidence shares the existing Drive folder without entering listing photos or resetting approval',async()=>{
 const {state,call}=setup();Object.assign(state.items[1],{status:'出品中',sales_channel:'メルカリ'});
 state.photo_reviews.push({item_id:itemId,drive_folder_id:'shared',approved_at:'approved',exported_photo_count:1});
 state.item_photos.push({id:'packed',item_id:itemId,storage_path:'photos/packed.jpg',photo_kind:'packing',drive_file_id:null,uploaded_by:'staff'});
 state.item_photos.push({id:'other-packed',item_id:'original',storage_path:'photos/other-packed.jpg',photo_kind:'packing',drive_file_id:null,uploaded_by:'other'});
 assert.deepEqual((await (await call('list')).json()).photos.map(p=>p.id),['p1','p2']);
 assert.deepEqual((await (await call('list',{purpose:'packing'})).json()).photos.map(p=>p.id),['packed']);
 assert.equal(state.google.length,0);
 const before=JSON.stringify(state.photo_reviews);
 const response=await call('save',{purpose:'packing'});assert.equal(response.status,200);
 assert.deepEqual(await response.json(),{folderId:'shared',added:1,total:1});
 assert.deepEqual(state.downloads,['photos/packed.jpg']);
 assert.equal(state.notices.length,1);assert.deepEqual(state.notices[0],{p_item_id:itemId,p_source_photo_id:'packed',p_photo_count:1});
 assert.equal(JSON.stringify(state.photo_reviews),before);
 const upload=state.google.find(req=>req.url.includes('/upload/drive/'));
 assert.deepEqual(JSON.parse(upload.body).parents,['shared']);
});
test('packing export accepts only the configured pre-transition stage and retains authorization',async()=>{
 for(const sales_channel of ['FBA','自己発送','メルカリ','ヤフオク']){
  for(const status of ['検品中','商品登録前','出品中','取引中','販売済']){
   const {state,call}=setup();Object.assign(state.items[1],{status,sales_channel});
   state.item_photos.push({id:'packed',item_id:itemId,storage_path:'packed.jpg',photo_kind:'packing',drive_file_id:null,uploaded_by:'staff'});
   const allowed=sales_channel==='FBA'?status==='商品登録前':status==='出品中';
   assert.equal((await call('save',{purpose:'packing'})).status,allowed?200:409,sales_channel+status);
   if(!allowed)assert.equal(state.google.length,0);
  }
 }
 const {call}=setup({assigned:false});assert.equal((await call('save',{purpose:'packing'})).status,403);
});

test('rejected photos can be resubmitted without duplicate file uploads',async()=>{
 const {state,call}=setup();assert.equal((await call('save')).status,200);
 const review=state.photo_reviews.find(row=>row.item_id===itemId);review.rejected_at='returned';review.submitted_at='old-submission';
 const downloads=state.downloads.length;const uploads=state.google.filter(row=>row.url.includes('/upload/drive/')).length;
 const response=await call('save');assert.equal(response.status,200);assert.equal((await response.json()).added,0);
 assert.notEqual(review.submitted_at,'old-submission','A new submission reaches the DB resubmission trigger');
 assert.equal(state.downloads.length,downloads);assert.equal(state.google.filter(row=>row.url.includes('/upload/drive/')).length,uploads);
});

function reflectionSetup(){
 const fixture=setup();const {state}=fixture;
 Object.assign(state.items[0],{sku:'123-AAII-20261020-1000',is_accessory:false});
 Object.assign(state.items[1],{sku:'123a-AAII-20261020-1000',status:'商品登録前',is_accessory:false});
 return fixture;
}
test('a-series lists and saves only its own product photos; packing remains isolated',async()=>{
 const {state,call}=reflectionSetup();
 assert.deepEqual((await (await call('list')).json()).photos.map(row=>row.id),['p2']);
 assert.equal((await call('save')).status,200);
 assert.deepEqual(state.downloads,['photos/new.jpg']);
 assert(!state.google.some(req=>req.url.includes('/files/old-file')));
});
test('original lot does not display or export staged reflected copies from another item',async()=>{
 const {state,call}=setup();state.item_photos.push({id:'copied',item_id:'original',storage_path:'123a-SKU/reflected-source.jpg',drive_file_id:null,uploaded_by:'staff'});
 assert.deepEqual((await (await call('list')).json()).photos.map(row=>row.id),['p1','p2']);
 assert.equal((await call('save')).status,200);
 assert(!state.downloads.includes('123a-SKU/reflected-source.jpg'),'A save on a different item cannot submit staged reflected copies');
 assert.equal(state.item_photos.find(row=>row.id==='copied').drive_file_id,null);
});
test('reflection reads original Drive product photos only, keeps source order, and never submits review',async()=>{
 const {state,call}=reflectionSetup();
 state.items.push({id:'sibling',lot_seq:123,sku:'123b-AAII-20261020-1000'});
 state.item_photos=[
  {...state.item_photos[0],created_at:'2026-10-20T02:00:00Z'},
  {id:'p0',item_id:'original',storage_path:'first.jpg',drive_file_id:'first-file',uploaded_by:'other',created_at:'2026-10-20T01:00:00Z'},
  {id:'packed',item_id:'original',photo_kind:'packing',drive_file_id:'packing-file',uploaded_by:'other'},
  {id:'unsaved',item_id:'original',photo_kind:'product',drive_file_id:null,uploaded_by:'other'},
  {id:'external',item_id:'original',photo_kind:'product',drive_file_id:'external-file',uploaded_by:null},
  {id:'sibling',item_id:'sibling',photo_kind:'product',drive_file_id:'sibling-file',uploaded_by:'other'},
 ];
 const originals=JSON.stringify(state.item_photos);const reviews=JSON.stringify(state.photo_reviews);
 const response=await call('reflect');assert.equal(response.status,200);
 assert.deepEqual(await response.json(),{sourceSerial:'123',added:2,total:2});
 assert.deepEqual(state.copies.map(row=>row.path),['123a-AAII-20261020-1000/reflected-p0.jpg','123a-AAII-20261020-1000/reflected-p1.jpg']);
 assert.equal(JSON.stringify(state.item_photos.slice(0,6)),originals);
 assert(state.item_photos.filter(row=>row.item_id===itemId).every(row=>row.drive_file_id===null));
 assert.equal(JSON.stringify(state.photo_reviews),reviews);assert.equal(state.notices.length,0);
 assert(state.google.every(req=>req.url.includes('oauth2')||req.url.includes('alt=media')),'No Drive writes on reflection');
 const operations=state.google.length;
 assert.deepEqual(await (await call('reflect')).json(),{sourceSerial:'123',added:0,total:2});
 assert.equal(state.google.length,operations,'Already reflected photos require no additional Drive reads');
});
test('partial Drive failure preserves copied photos and retry imports only the remainder',async()=>{
 const {state,call}=reflectionSetup();state.item_photos[0].created_at='2026-10-20T01:00:00Z';
 state.item_photos.push({id:'later',item_id:'original',drive_file_id:'missing-file',uploaded_by:'other',created_at:'2026-10-20T02:00:00Z'});
 state.mediaFailure='missing-file';const failed=await call('reflect');assert.equal(failed.status,502);assert.match((await failed.json()).error,/1枚反映済み/);
 assert.equal(state.copies.length,1);state.mediaFailure=null;
 const retry=await call('reflect');assert.equal(retry.status,200);assert.equal((await retry.json()).added,1);assert.equal(state.copies.length,2);
 assert.equal(state.item_photos.filter(row=>row.storage_path?.includes('reflected-p1')).length,1);
});
test('reflection rejects wrong stage/purpose, missing or ambiguous originals, and unassigned actors',async()=>{
 for(const alter of [s=>s.items[1].status='出品中',s=>s.items[1].sku='123b-AAII-20261020-1000',s=>s.items[0].is_accessory=true,s=>s.items.push({...s.items[0],id:'duplicate'})]){
  const {state,call}=reflectionSetup();alter(state);assert.equal((await call('reflect')).status,409);assert.equal(state.google.length,0);
 }
 const {state,call}=reflectionSetup();assert.equal((await call('reflect',{purpose:'packing'})).status,409);
 state.items[1].deliverer_id='other';assert.equal((await call('reflect')).status,403);assert.equal(state.google.length,0);
});
