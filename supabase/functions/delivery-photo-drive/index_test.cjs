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
    google:[], downloads:[], signed:[],
  };
  const service = {
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
    }}},
  };
  const fetch = async (url, init={}) => {
    state.google.push({url:String(url),...init});
    if(String(url).includes('oauth2')) return Response.json({access_token:'test-token'});
    if(String(url).includes('/upload/drive/')) return new Response('{}',{headers:{Location:'https://www.googleapis.com/upload/session'}});
    if(String(url).includes('/upload/session')) return Response.json({id:'new-file'});
    if(String(url).includes('/files/shared?') && !init.method) return Response.json({id:'shared',name:'old-sku'});
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

test('working Amazon return defaults to Mercari while ordinary defaults are retained',()=>{
  const path=__dirname+'/../../../apps/delivery/src/components/DescriptionEditor.tsx';
  const source=fs.readFileSync(path,'utf8');
  const ast=ts.createSourceFile(path,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  const fn=ast.statements.find(node=>ts.isFunctionDeclaration(node) && node.name?.text==='initialTarget');
  assert(fn);
  const code=ts.transpileModule(fn.getText(ast),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
  const initialTarget=new Function(code+'; return initialTarget;')();
  assert.equal(initialTarget({marketplace:'動作品Amazon返品',sales_channel:'FBA'}),'mercari');
  assert.equal(initialTarget({marketplace:'動作品Amazon返品',sales_channel:'ヤフオク'}),'mercari');
  assert.equal(initialTarget({marketplace:'Amazon返品',sales_channel:'FBA'}),'amazon');
  assert.equal(initialTarget({marketplace:'ヤフオク',sales_channel:'ヤフオク'}),'yahoo-auction');
});
