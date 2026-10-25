import {paceNavigation} from './navigation-pacing.js';

const origins={yamato:'https://toi.kuronekoyamato.co.jp',japanpost:'https://trackings.post.japanpost.jp'};
export function shippingReceiptValid(receipt){return !!origins[receipt?.carrier]&&/^[0-9]{11,13}$/.test(receipt?.tracking_number||'');}
/** Runs in an isolated page world. Only current outbound shipment labels, never incoming inventory tracking. */
export function readOutboundReceipt({external_id,channel}){
 const visible=e=>e.getClientRects().length>0&&getComputedStyle(e).visibility!=='hidden';
 const normalize=t=>String(t||'').normalize('NFKC').replace(/\s+/g,' ').trim();
 if(channel==='メルカリ'&&(location.hostname!=='jp.mercari.com'||location.pathname!=='/transaction/'+external_id))throw Error('対象取引が一致しません');
 if(channel==='ヤフオク'&&(!['contact.auctions.yahoo.co.jp','buy.auctions.yahoo.co.jp'].includes(location.hostname)||![...new URL(location.href).searchParams.values()].includes(external_id)))throw Error('対象取引が一致しません');
 const root=document.querySelector('main')||document.body;
 const inMessages=e=>{const h=[...root.querySelectorAll('h2,h3')].filter(h=>visible(h)&&(h.compareDocumentPosition(e)&Node.DOCUMENT_POSITION_FOLLOWING)).at(-1);return h&&/メッセージ|コメント/.test(normalize(h.innerText));};
 const nodes=[...root.querySelectorAll('p,span,dt,dd,td,th,div')].filter(e=>visible(e)&&!inMessages(e)&&!e.children.length&&!e.closest('textarea,button'));
 const text=normalize(nodes.map(n=>n.innerText).join(' '));
 const numbers=new Set([...text.matchAll(/(?:送り状番号|お問い合わせ番号|お問合せ番号|追跡番号|伝票番号)\s*[:：]?\s*([0-9][0-9 -]{9,18}[0-9])/g)].map(m=>m[1].replace(/\D/g,'')));
 for(const n of nodes){if(!/^(送り状番号|お問い合わせ番号|お問合せ番号|追跡番号|伝票番号)[：:]?$/.test(normalize(n.innerText)))continue;const next=n.nextElementSibling||n.parentElement?.nextElementSibling;if(next&&visible(next)){const s=normalize(next.innerText);if(/^[0-9 -]{11,18}$/.test(s))numbers.add(s.replace(/\D/g,''));}}
 const links=[...root.querySelectorAll('a[href]')].filter(e=>visible(e)&&!inMessages(e)).flatMap(a=>{try{const u=new URL(a.href);if(u.protocol!=='https:')return [];const carrier=u.hostname==='toi.kuronekoyamato.co.jp'?'yamato':u.hostname==='trackings.post.japanpost.jp'?'japanpost':null;if(!carrier)return [];const values=[...u.searchParams.entries()].filter(([k])=>/^(number\d+|reqCodeNo\d+|requestNo\d+)$/i.test(k)).map(([,v])=>v.replace(/\D/g,''));return values.map(tracking_number=>({carrier,tracking_number}));}catch{return [];}});
 const carriers=new Set(links.map(l=>l.carrier));
 if(/らくらくメルカリ便|ヤマト運輸|宅急便/.test(text))carriers.add('yamato');
 if(/ゆうゆうメルカリ便|日本郵便|ゆうパック|ゆうパケット/.test(text))carriers.add('japanpost');
 for(const l of links)numbers.add(l.tracking_number);
 if(numbers.size!==1||carriers.size!==1)return {unavailable:true,numberCount:numbers.size,carriers:[...carriers],labels:nodes.map(n=>normalize(n.innerText)).filter(t=>t.length<90&&/送り状|追跡番号|お問い合わせ番号|お問合せ番号|伝票番号|らくらく|ゆうゆう/.test(t)).slice(0,12)};
 const tracking_number=[...numbers][0];if(!/^[0-9]{11,13}$/.test(tracking_number))return {unavailable:true};
 const purchase=text.match(/購入日時\s*[:：]?\s*(20\d{2})[年/.-](\d{1,2})[月/.-](\d{1,2})(?:日)?\s+(\d{1,2})[:：](\d{2})/);
 return {carrier:[...carriers][0],tracking_number,...(purchase?{trade_key:external_id+':'+purchase[1]+'-'+purchase[2].padStart(2,'0')+'-'+purchase[3].padStart(2,'0')+'T'+purchase[4].padStart(2,'0')+':'+purchase[5]}:{})};
}

/** Parse inert carrier HTML in the page world. Only acceptance history proves shipment. */
export function parseCarrierReceipts({html,carrier,receipts,now=Date.now()}){
 const doc=new DOMParser().parseFromString(html,'text/html'),norm=s=>String(s||'').normalize('NFKC').replace(/\s+/g,' ').trim();
 const plain=e=>norm(e?.textContent),out=[];
 if(/メンテナンス|アクセスが集中|ロボット|認証コード/.test(plain(doc.querySelector('h1'))))return [];
 for(const r of receipts){
  let acceptance;
  if(carrier==='yamato'){
   const blocks=[...doc.querySelectorAll('.parts-tracking-invoice-block')].filter(b=>plain(b.querySelector('h3')).replace(/^.*件目[:：]\s*/,'').replace(/\D/g,'')===r.tracking_number);
   if(blocks.length!==1)continue;
   const events=[...blocks[0].querySelectorAll('.tracking-invoice-block-detail li')].filter(e=>/^(荷物受付|発送済み)$/.test(plain(e.querySelector('.item'))));
   for(const e of events){const m=plain(e.querySelector('.date')).match(/^(\d{1,2})月(\d{1,2})日 (\d{1,2}):(\d{2})$/);if(!m)continue;const current=new Date(now+9*3600000),year=current.getUTCFullYear()-(+m[1]>current.getUTCMonth()+2?1:0);acceptance=`${year}-${m[1].padStart(2,'0')}-${m[2].padStart(2,'0')}T${m[3].padStart(2,'0')}:${m[4]}:00+09:00`;break;}
  }else if(carrier==='japanpost'){
   // A number heading and its own history must share one result block.
   const headings=[...doc.querySelectorAll('h2,h3,h4,caption')].filter(e=>plain(e).replace(/\D/g,'')===r.tracking_number);
   if(headings.length===1){let block=headings[0].parentElement;
    for(let n=0;block&&n<3&&!block.querySelector('tr');n++)block=block.parentElement;
    if(block&&block!==doc.body)for(const row of block.querySelectorAll('tr')){const cells=[...row.querySelectorAll('td')].map(plain),idx=cells.findIndex(s=>s==='引受');if(idx<0)continue;const m=cells.join(' ').match(/(20\d{2})\/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})/);if(m)acceptance=`${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}T${m[4].padStart(2,'0')}:${m[5]}:00+09:00`;}
   }
   // The official ten-number summary also proves a physical handling scan.
   // Date-only scans use midnight, conservatively excluding scans before this trade.
   if(!acceptance){const rows=[...doc.querySelectorAll('tr')].filter(row=>{const cells=[...row.querySelectorAll('td')];return cells.length>=4&&plain(cells[0]).replace(/\D/g,'')===r.tracking_number;});
    if(rows.length===1){const cells=[...rows[0].querySelectorAll('td')].map(plain);if(/^(引受|中継|到着|持ち出し中|お届け先にお届け済み|配達完了|お届け済み)$/.test(cells[3])){const m=cells[2].match(/^(20\d{2})\/(\d{1,2})\/(\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?$/);if(m)acceptance=`${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}T${(m[4]||'00').padStart(2,'0')}:${m[5]||'00'}:00+09:00`;}}
   }
  }
  const time=Date.parse(acceptance||''),part=String(r.trade_key||'').slice(String(r.trade_key||'').indexOf(':')+1),trade=Date.parse(part+(part.includes('T')?'':'T00:00')+'+09:00');
  if(!Number.isFinite(time)||!Number.isFinite(trade)||time<trade||time>now||now-time>90*86400000)continue;
  out.push({carrier,tracking_number:r.tracking_number,accepted_at:acceptance,observed_at:new Date(now).toISOString(),source:carrier==='yamato'?'https://toi.kuronekoyamato.co.jp/cgi-bin/tneko':'https://trackings.post.japanpost.jp/services/srv/search',accepted:true});
 }
 return out;
}

export async function fetchCarrierReceipts({receipts,parse,fetchPage=fetch,pace=paceNavigation,now=Date.now()}){
 const proofs=new Map();
 for(const carrier of Object.keys(origins)){
  const rows=receipts.filter(r=>r.carrier===carrier&&shippingReceiptValid(r));
  for(let start=0;start<rows.length;start+=10){const group=rows.slice(start,start+10),params=new URLSearchParams();
   group.forEach((r,i)=>params.set(carrier==='yamato'?'number'+String(i+1).padStart(2,'0'):'requestNo'+(i+1),r.tracking_number));
   const base=origins[carrier]+(carrier==='yamato'?'/cgi-bin/tneko':'/services/srv/search');if(carrier==='japanpost')params.set('locale','ja');
   const response=await pace(()=>fetchPage(carrier==='yamato'?base:base+'?'+params,{method:carrier==='yamato'?'POST':'GET',...(carrier==='yamato'?{body:params}:{}),credentials:'omit',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(20000)}));
   if(!response.ok)throw Error('配送会社の追跡情報を取得できません');
   const bytes=await response.arrayBuffer();if(bytes.byteLength>2500000)throw Error('追跡応答の容量を確認してください');
   const content=response.headers.get('content-type')||'',head=new TextDecoder().decode(bytes.slice(0,1000));
   const html=new TextDecoder(/shift.?jis|sjis/i.test(content+' '+head)?'shift_jis':'utf-8').decode(bytes);
   for(const proof of await parse({html,carrier,receipts:group,now}))proofs.set(carrier+':'+proof.tracking_number,proof);
  }
 }
 return proofs;
}

export async function processDailyShipping({jobs,session,rpc,log,fetchReceipts=fetchCarrierReceipts}){
 const pending=[],finish=async(job,proof,already=false)=>{
  const operation=await rpc('extension_claim_daily_shipping_notice',{p_item_id:job.item_id,p_trade_key:job.trade_key,p_expected_updated_at:job.expected_updated_at,p_proof:proof});if(!operation)return;
  let status='failed',result,mutating=false;
  try{if(already)result={notified:true,already_notified:true,note:'サイトで発送通知済みを確認しました。再送していません'};
   else{const current=await session.outboundReceipt(job);if(current?.carrier!==proof.carrier||current?.tracking_number!==proof.tracking_number)throw Error('発送する荷物が変更されたため通知しません');mutating=true;result=await session.operation(operation,'ship_notice');}
   status='succeeded';result={...result,automatic:true,receipt:proof};
  }catch(e){status=mutating?'uncertain':'failed';result={automatic:true,note:e.message};}
  await rpc('extension_finish_seller_operation',{p_id:operation.id,p_status:status,p_result:result});
  if(status!=='succeeded')await log('error','自動発送通知を停止しました：'+result.note);
 };
 for(const job of jobs){try{
  if(shippingReceiptValid(job.receipt)){pending.push({...job,...job.receipt,trade_key:job.trade_key});continue;}
  await session.go(job.url);const state=await session.operation(job,'ship_notice_preflight');
  if(state.alreadyNotified){await finish(job,{already_notified:true,observed_at:state.observed_at},true);continue;}
  const receipt=await session.outboundReceipt(job);if(shippingReceiptValid(receipt))pending.push({...job,...receipt,trade_key:job.trade_key});
  else await log('info','自動発送通知：'+job.inventory_sku+' は発送前の画面で送り状番号を確認できず保留しました。QR発行だけでは受付済みと判定しません');
 }catch(e){await log('warning','自動発送通知の確認を保留しました：'+e.message);}}
 if(!pending.length)return;
 let proofs;try{proofs=await fetchReceipts({receipts:pending,parse:args=>session.parseCarrierReceipts(args)});}catch(e){await log('warning','配送会社の確認を翌日に回します：'+e.message);return;}
 for(const job of pending){const proof=proofs.get(job.carrier+':'+job.tracking_number);if(!proof)continue;
  try{await session.go(job.url);const state=await session.operation(job,'ship_notice_preflight');await finish(job,state.alreadyNotified?{already_notified:true,observed_at:state.observed_at}:proof,!!state.alreadyNotified);}
  catch(e){await log('warning','自動発送通知を保留しました：'+e.message);}
 }
}
