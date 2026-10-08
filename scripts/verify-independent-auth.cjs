const assert = require('node:assert/strict');
const {createRequire} = require('node:module');
const Module = require('node:module');
const path = require('node:path');
const r = createRequire(path.resolve('apps/admin/package.json'));
const esbuild = createRequire(r.resolve('vite/package.json'))('esbuild');
const {createClient} = require('@supabase/supabase-js');
const user = {id:'11111111-1111-4111-8111-111111111111',aud:'authenticated',email:'fixture@example.invalid'};
const token = name => ['eyJhbGciOiJIUzI1NiJ9',Buffer.from(JSON.stringify({sub:user.id,exp:4102444800,session_id:name})).toString('base64url'),'fixture'].join('.');
const session = name => ({access_token:token(name),refresh_token:name,expires_at:4102444800,expires_in:3600,token_type:'bearer',user});
const active = new Set(['web','extension']);
const requests = [];
global.fetch = async (input,options={}) => {
  const url = new URL(String(input));
  requests.push(url.pathname+url.search);
  let body;
  if(url.pathname.endsWith('/email-only-login')) body = {session:session('web')};
  else if(url.pathname.endsWith('/user')) body = user;
  else if(url.pathname.endsWith('/logout')) {
    const scope=url.searchParams.get('scope');
    if(scope==='local') active.delete('web'); else active.clear();
    return new Response(null,{status:204});
  } else if(url.pathname.endsWith('/token')) {
    const refresh=JSON.parse(options.body).refresh_token;
    assert(active.has(refresh),'The independent extension session must remain valid');
    body=session(refresh);
  } else if(url.pathname.endsWith('/marketplace_purchase_import')) body={inserted:1};
  else if(url.pathname.endsWith('/reconcile_marketplace_tracking')) body={updated:true};
  else throw new Error('Unexpected fixture request: '+url.pathname);
  return new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json'}});
};
(async()=>{
  const built=await esbuild.build({entryPoints:['packages/shared/src/supabase.ts'],bundle:true,platform:'node',format:'cjs',write:false,external:['@supabase/supabase-js'],define:{'import.meta.env.VITE_SUPABASE_URL':'"https://fixture.invalid"','import.meta.env.VITE_SUPABASE_ANON_KEY':'"fixture-public-key"'}});
  const m=new Module(path.resolve('scripts/independent-auth-fixture.cjs'),module);
  m.filename=path.resolve('scripts/independent-auth-fixture.cjs');m.paths=module.paths;m._compile(built.outputFiles[0].text,m.filename);
  const app=m.exports;
  const extension=createClient('https://fixture.invalid','fixture-public-key',{db:{schema:'app'},auth:{persistSession:false,autoRefreshToken:false}});
  try {
    await app.signIn(user.email);
    assert.equal((await extension.auth.setSession(session('extension'))).error,null);
    await app.signOut();
    assert.equal((await app.getSupabase().auth.getSession()).data.session,null);
    assert(requests.includes('/auth/v1/logout?scope=local'));
    assert(!active.has('web'));
    assert(active.has('extension'));
    assert.equal((await extension.auth.refreshSession()).error,null);
    assert.equal((await extension.rpc('reconcile_marketplace_tracking',{})).data.updated,true);
    assert.equal((await extension.rpc('marketplace_purchase_import',{})).data.inserted,1);
    console.log('PASS: actual app logout clears the web session; independent extension refresh and both registration RPCs continue.');
  } finally {await app.getSupabase().auth.stopAutoRefresh();await extension.auth.stopAutoRefresh();}
  // Supabase's Node transport retains background handles after client cleanup.
  process.exit(0);
})().catch(e=>{console.error(e.message);process.exitCode=1;});
