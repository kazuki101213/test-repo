const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('../../../node_modules/typescript');
const itemId='00000000-0000-0000-0000-000000000001',requestId='00000000-0000-0000-0000-000000000002',photoId='00000000-0000-0000-0000-000000000003';
function setup({assigned=true,active=true,status='検品中',googleFails=false}={}){
 const state={profiles:[{user_id:'user',staff_id:'staff'}],staff:[{id:'staff',role:'deliverer',is_active:active}],items:[{id:itemId,sku:'2500-test',lot_seq:2500,status,deliverer_id:assigned?'staff':'other',purchaser_id:'purchaser',is_accessory:false}],malfunction_report_photos:[],google:[]};
 const client={auth:{getUser:async()=>({data:{user:{id:'user'}},error:null})},from(table){let filters=[],insert;const q={select(){return q;},eq(k,v){filters.push(row=>row[k]===v);return q;},insert(row){insert=row;return q;},maybeSingle:()=>run(true),then:(a,b)=>run(false).then(a,b)};async function run(single){if(insert)state[table].push(insert);const rows=state[table].filter(row=>filters.every(fn=>fn(row)));return {data:single?rows[0]??null:rows,error:null};}return q;}};
 const fetch=async(url,init={})=>{
  state.google.push({url:String(url),method:init.method??'GET'});
  if(googleFails)return new Response('{}',{status:502});
  if(String(url).includes('oauth2.googleapis.com'))return Response.json({access_token:'fixture-token'});
  if(String(url).includes('/upload/session-fixture'))return Response.json({id:'fixture_drive_file_123'});
  if(String(url).includes('/upload/'))return new Response('{}',{headers:{Location:'https://www.googleapis.com/upload/session-fixture'}});
  if((init.method??'GET')==='POST')return Response.json({id:'fixture_folder_123'});
  return Response.json({files:[]});
 };
 let source=fs.readFileSync(__dirname+'/index.ts','utf8').replace(/import \{ createClient \}[^\n]+\n/,'').replace('if(import.meta.main)Deno.serve(handler);','');
 const context={exports:{},createClient:()=>client,fetch,Response,Request,Blob,File,FormData,URLSearchParams,Uint8Array,Deno:{env:{get:key=>key==='GOOGLE_DRIVE_ROOT_FOLDER_ID'?'fixture_root':'fixture-setting'}}};
 vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,context);
 async function request({auth=true,id=itemId,mime='image/jpeg',bytes=[255,216,255,0]}={}){const form=new FormData();form.set('itemId',id);form.set('requestId',requestId);form.set('photoId',photoId);form.set('sortOrder','0');form.set('file',new File([new Uint8Array(bytes)],'fixture.jpg',{type:mime}));return context.exports.handler(new Request('https://fixture.invalid',{method:'POST',headers:auth?{authorization:'Bearer fixture'}:{},body:form}));}
 return{state,request};
}
test('Upload goes only to private Drive and retry reuses the staged photo',async()=>{
 const {state,request}=setup();const response=await request();assert.equal(response.status,200);assert.deepEqual(await response.json(),{id:photoId});assert.equal(state.malfunction_report_photos.length,1);assert.equal(state.malfunction_report_photos[0].drive_file_id,'fixture_drive_file_123');assert(!state.google.some(row=>row.url.includes('permissions')));
 const calls=state.google.length;state.items[0].status='動作不良';assert.equal((await request()).status,200);assert.equal(state.google.length,calls);assert.equal(state.malfunction_report_photos.length,1);
 state.malfunction_report_photos[0].uploaded_by='other';assert.equal((await request()).status,409);
});
test('Unauthorized, inactive, malformed and invalid images cannot reach Drive',async()=>{
 for(const options of [{assigned:false},{active:false},{status:'販売済'}]){const {request,state}=setup(options);assert([403,409].includes((await request()).status));assert.equal(state.google.length,0);}
 for(const options of [{auth:false},{id:'wrong'},{mime:'text/plain'},{bytes:[1,2,3]}]){const {request,state}=setup();assert([400,401].includes((await request(options)).status));assert.equal(state.google.length,0);}
});
test('Drive failure creates no attachment metadata or report transition',async()=>{const {request,state}=setup({googleFails:true});assert.equal((await request()).status,502);assert.equal(state.malfunction_report_photos.length,0);assert.equal(state.items[0].status,'検品中');});
