import { assert, assertEquals } from 'jsr:@std/assert@1.0.19';
import { notificationBody, validSubscription } from './validation.ts';
import { ApplicationServer, exportVapidKeys, importVapidKeys, generateVapidKeys } from 'jsr:@negrel/webpush@0.5.0';

Deno.test('push destinations and keys reject arbitrary/private endpoints', async () => {
  const keys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey));
  const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  const sub = { endpoint:'https://web.push.apple.com/example', keys:{ p256dh:b64(raw), auth:b64(crypto.getRandomValues(new Uint8Array(16))) } };
  assert(validSubscription(sub));
  for (const endpoint of ['http://web.push.apple.com/example','https://localhost/example','https://web.push.apple.com.evil.example/test','https://user:pass@web.push.apple.com/example','https://web.push.apple.com:8443/example']) assert(!validSubscription({ ...sub, endpoint }));
  assert(!validSubscription({ ...sub, keys:{ ...sub.keys, auth:'short' } }));
  assertEquals(notificationBody('reply',2198),'【2198】メッセージが届きました');
  assertEquals(notificationBody('photo',2198),'【2198】写真が承認されました。');
});

Deno.test('VAPID import and real encrypted push request', async () => {
  const vapidKeys = await importVapidKeys(await exportVapidKeys(await generateVapidKeys({ extractable:true })));
  const server = await ApplicationServer.new({ contactInformation:'https://test-repo-delivery.vercel.app/',vapidKeys });
  const clientKeys = await crypto.subtle.generateKey({ name:'ECDH',namedCurve:'P-256' },true,['deriveBits']);
  const p256dh = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.exportKey('raw',clientKeys.publicKey)))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  const originalFetch = globalThis.fetch;
  let requests=0;
  globalThis.fetch = (input, init) => {
    requests++;
    assertEquals(String(input),'https://web.push.apple.com/encryption-check');
    assertEquals(init?.method,'POST');
    const headers=new Headers(init?.headers);
    assertEquals(headers.get('Content-Encoding'),'aes128gcm');
    assert(headers.get('Authorization')?.startsWith('vapid '));
    assert(init?.body instanceof Uint8Array || init?.body instanceof ArrayBuffer);
    return Promise.resolve(new Response(null,{status:201}));
  };
  try { await server.subscribe({ endpoint:'https://web.push.apple.com/encryption-check',keys:{p256dh,auth:btoa('1234567890123456')} }).pushTextMessage(JSON.stringify({body:notificationBody('reply',2198)}),{ttl:300}); }
  finally { globalThis.fetch=originalFetch; }
  assertEquals(requests,1);
});
