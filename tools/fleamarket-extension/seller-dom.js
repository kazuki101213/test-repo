/** Executed in an isolated extension world. Unknown/ambiguous controls stop before submission. */
export async function sellerDomOperation({job,phase,files=[],categoryResolved=false,choicesResolved=false,shippingPrepared=false,waitForShippingCode=false,reportErrors=false,confirmationSteps=[]}){
 try{
 const norm=value=>String(value??'').replace(/\s+/g,' ').trim(),visible=e=>!!e&&e.getClientRects().length>0&&getComputedStyle(e).visibility!=='hidden';
 let root=document.querySelector('main')||document.body;const text=()=>norm((document.querySelector('main')||document.body).innerText),payload=job.payload;
 const hosts=job.channel==='メルカリ'?['jp.mercari.com']:['auctions.yahoo.co.jp','page.auctions.yahoo.co.jp','contact.auctions.yahoo.co.jp','buy.auctions.yahoo.co.jp'];
 if(location.protocol!=='https:'||!hosts.includes(location.hostname)||document.querySelector('input[type="password"],input[autocomplete="one-time-code"]')||/文字認証|認証コードを入力|ロボットではない|セキュリティチェック/.test(text()))throw Error('販売サイトへのログイン・追加認証が必要です');
 const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 const controls=()=>[...root.querySelectorAll('button,input[type="submit"],input[type="button"],[role="button"]')].filter(visible);
 const buttonLabel=e=>norm(e.innerText||e.getAttribute('aria-label')||e.value);
 const noticeNames=['発送したことを通知する','商品の発送を通知する','発送通知をする','発送通知','商品を発送したので発送連絡する','商品を発送したので、発送通知をする','商品を発送したので発送通知をする',...(job.channel==='ヤフオク'?['商品を発送したので発送連絡をする','発送連絡をする']:[])];
 function noticeButtons(){return controls().filter(e=>{
  if(!noticeNames.includes(buttonLabel(e)))return false;
  if(e.closest('form')?.querySelector('textarea'))return false;
  const heading=[...root.querySelectorAll('h2,h3')].filter(h=>visible(h)&&(h.compareDocumentPosition(e)&Node.DOCUMENT_POSITION_FOLLOWING)).at(-1);
  return !heading||!/メッセージ|コメント/.test(norm(heading.innerText));
 });}

 function shippingNoticeCompleted(){
  if(job.channel==='ヤフオク')return noticeButtons().length===0&&[...root.querySelectorAll('[role=status],p,h2,h3')].filter(visible).some(e=>/^(商品の発送を連絡しました|発送連絡が完了しました|落札者の受け取り連絡をお待ちください)[。.]?$/.test(norm(e.innerText)));
  return /受取評価を依頼できます/.test(root.innerText)&&[...root.querySelectorAll('h2,h3')].some(e=>visible(e)&&/^(配送状況|配送情報)$/.test(norm(e.innerText)))&&noticeButtons().length===0;
 }
 function oneButton(names,scope=root){const values=[...scope.querySelectorAll('button,input[type="submit"],input[type="button"],[role="button"]')].filter(e=>visible(e)&&names.includes(buttonLabel(e)));if(values.length!==1||values[0].disabled)throw Error('操作ボタンを1件に確認できません：'+names[0]);return values[0];}
 const fields=()=>[...root.querySelectorAll('input:not([type="hidden"]):not([type="file"]),textarea,select')].filter(visible);
 function label(field){return norm([field.getAttribute('aria-label'),...(field.labels?[...field.labels].map(e=>e.innerText):[]),field.getAttribute('placeholder')].filter(Boolean).join(' '));}
 function candidates(names,aliases=[]){
  const known=[...aliases,...(/状態/.test(names[0])?['istatus']: /送料/.test(names[0])?['shippingPayer','shipping_dummy']: /配送の方法|配送方法/.test(names[0])?['shipmethod_dummy']: /発送元/.test(names[0])?['loc_cd','shippingFromArea']: /発送まで/.test(names[0])?['shipschedule','shippingDuration']:[])];
  const named=fields().filter(e=>known.includes(e.name)||known.includes(e.id));
  return named.length?named:fields().filter(e=>names.some(name=>label(e).startsWith(name)));
 }
 function field(names,aliases=[]){const exact=candidates(names,aliases);if(exact.length!==1)throw Error('入力欄を1件に確認できません：'+names[0]);return exact[0];}
 function setValue(element,value){const prototype=element.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:element.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype;const setter=Object.getOwnPropertyDescriptor(prototype,'value')?.set;if(!setter)throw Error('入力形式に対応していません');setter.call(element,String(value));element.dispatchEvent(new Event('input',{bubbles:true}));element.dispatchEvent(new Event('change',{bubbles:true}));if(element.value!==String(value))throw Error('入力結果が一致しません');}
 function descriptionField(){
  const known=job.channel==='ヤフオク'?root.querySelector('textarea#fleaDescription[name="Description_plain_work"]'):null;
  if(known){const editor=root.querySelector('iframe#rteEditorComposition0');if(!editor?.contentDocument?.body?.isContentEditable)throw Error('説明文エディターを確認できません');return known;}
  return field(['商品の説明','商品説明','説明文'],['description','Description']);
 }
 function descriptionEditor(){return job.channel==='ヤフオク'?root.querySelector('iframe#rteEditorComposition0')?.contentDocument?.body:null;}
 function setDescription(target,value){const editor=descriptionEditor();if(editor){const doc=editor.ownerDocument,lines=String(value).replace(/\r\n?/g,'\n').split('\n');editor.replaceChildren(...lines.flatMap((line,index)=>index?[doc.createElement('br'),doc.createTextNode(line)]:[doc.createTextNode(line)]));editor.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:value}));editor.dispatchEvent(new Event('change',{bubbles:true}));}setValue(target,value);}
 const choiceText=value=>norm(value).replace(/[（）()・\s]/g,'').replace(/[〜～~]/g,'-');
 const choiceNames=names=>/カテゴリ/.test(names.join(' '))?['カテゴリーを選択する','カテゴリを選択する']:/状態/.test(names[0])?['商品の状態を選択する']:/配送/.test(names[0])?['配送の方法を選択する']:[];
 function choiceTrigger(names){const labels=choiceNames(names),mercariPath=/カテゴリ/.test(names.join(' '))?'/sell/categories':/状態/.test(names[0])?'/sell/conditions':/配送/.test(names[0])?'/sell/shipping_methods':null;const options=[...root.querySelectorAll('a,button,input[type="button"]')].filter(e=>visible(e)&&(labels.includes(buttonLabel(e))||mercariPath&&location.hostname==='jp.mercari.com'&&e.tagName==='A'&&e.origin===location.origin&&e.pathname===mercariPath||/カテゴリ/.test(names.join(' '))&&e.id==='acMdCateChange'));if(options.length!==1)return null;return options[0];}
 async function chooseLinked(names,value){
  const trigger=choiceTrigger(names);if(!trigger)throw Error('選択画面を1件に確認できません：'+names[0]);
  trigger.click();
  const category=/カテゴリ/.test(names.join(' '));
  const target=String(value).split(/\s*[>＞]\s*/).filter(Boolean).at(-1),wanted=choiceText(target);
  if(category){const search=await waitFor(()=>[...document.querySelectorAll('input')].filter(e=>visible(e)&&/カテゴリー名を検索|カテゴリ名を検索/.test(label(e))).find(e=>e.type==='text'||e.type==='search'),'カテゴリー検索欄を確認できません');setValue(search,target);}
  const selected=await waitFor(()=>{
   const scopes=[...document.querySelectorAll('[role="dialog"]')].filter(visible),scope=scopes.at(-1)||document.querySelector('main')||document.body;
   if(/配送/.test(names[0])){
    const radios=[...scope.querySelectorAll('input[type="radio"][name="selectedShippingMethod"]')].filter(e=>visible(e)&&!e.disabled&&(norm(label(e))===target||norm(label(e)).startsWith(target+' ')));
    if(radios.length===1)return radios[0];if(radios.length>1)throw Error('配送方法の選択肢が曖昧です');
   }
   const options=[...scope.querySelectorAll('a,button,[role="option"],label')].filter(e=>{
    if(!visible(e)||e.disabled||e===trigger)return false;
    const t=buttonLabel(e);return choiceText(t)===wanted||(/状態/.test(names[0])&&/^condition-[1-6]-row$/.test(e.getAttribute('data-testid')||'')&&t.startsWith(target+' '))||(category&&e.tagName==='A'&&t.startsWith(target+' '));
   });
   return options.length===1?options[0]:null;
  },'選択肢を1件に確認できません：'+names[0]);
  selected.click();await sleep(500);root=document.querySelector('main')||document.body;
 }
 async function choose(names,value,aliases=[]){
  const matches=candidates(names,aliases);
  if(!matches.length&&choiceTrigger(names))return chooseLinked(names,value);
  if(matches.length&&matches.every(e=>e.type==='radio')&&new Set(matches.map(e=>e.name)).size===1){
   const wanted=choiceText(value);const options=matches.filter(e=>{
    if(e.name==='shipping_dummy')return /購入者|落札者/.test(value)?e.value==='buyer':/出品者/.test(value)&&e.value==='seller';
    if(e.name==='shipmethod_dummy'&&/日本郵便/.test(value)){const method=['ゆうパケットプラス','ゆうパケットポストmini','ゆうパケット'].includes(payload.size)?payload.size:'ゆうパック';return label(e).startsWith(method+' ')||label(e)===method;}
    if(e.name==='shipmethod_dummy'&&/ヤマト運輸/.test(value))return payload.size==='宅急便コンパクト'?/^宅急便コンパクト[（(]EAZY[）)]/.test(label(e)):/^宅急便[（(]EAZY[）)].*60[〜～-]160/.test(label(e));
    return choiceText(label(e))===wanted||e.value===String(value);
   });
   if(options.length!==1||options[0].disabled)throw Error('ラジオの選択肢を1件に確認できません：'+names[0]);
   if(!options[0].checked)options[0].click();if(!options[0].checked)throw Error('選択結果を確認できません');return options[0];
  }
  const target=field(names,aliases);
  if(target.tagName==='SELECT'){const wanted=choiceText(value);const options=[...target.options].filter(option=>{
   if(target.name==='ClosingYMD'||target.id==='ClosingYMD'){const m=String(value).match(/^(\d{4})-(\d\d)-(\d\d)$/);return m&&(option.value===m.slice(1).join('')||new RegExp('^'+Number(m[2])+'月'+Number(m[3])+'日').test(norm(option.text)));}
   if(target.name==='ClosingTime'||target.id==='ClosingTime'){const hour=Number(value),prefix=(hour<12?'午前':'午後')+(hour%12)+'時';return option.value===String(value)||norm(option.text).startsWith(prefix+'から')||norm(option.text).startsWith(prefix+'（正午）から');}
   return choiceText(option.text)===wanted||choiceText(option.text).includes(wanted)||option.value===String(value);
  });const exact=options.filter(o=>choiceText(o.text)===wanted||o.value===String(value)),selected=exact.length?exact:options;if(selected.length!==1)throw Error('選択肢を1件に確認できません：'+names[0]);if(target.value!==selected[0].value)setValue(target,selected[0].value);return target;}
  if(target.tagName==='INPUT'&&target.type!=='radio'){setValue(target,value);return target;}
  throw Error('選択欄の形式に対応していません：'+names[0]);
 }
 function checkbox(names,checked){const target=field(names);if(target.type!=='checkbox')throw Error('チェック欄の形式に対応していません');if(target.checked!==checked)target.click();if(target.checked!==checked)throw Error('チェックの結果を確認できません');}
 const formSignature=()=>JSON.stringify({fields:fields().map(e=>({id:e.id,name:e.name,label:label(e),value:e.value,checked:e.type==='checkbox'||e.type==='radio'?e.checked:null})),editor:descriptionEditor()?.innerText??null});
 const imageSignature=zone=>JSON.stringify([...zone.querySelectorAll('img')].filter(visible).map(image=>image.src));
 const yahooPhotoSignature=count=>{
  if(job.channel!=='ヤフオク')return '';
  const value=name=>root.querySelector('input[name="'+name+'"]')?.value.trim()||'';
  const uploaded=url=>{try{const u=new URL(url);return u.protocol==='https:'&&/(^|[.])(?:yahoo[.]co[.]jp|yimg[.]jp)$/.test(u.hostname)&&!/\/(?:load|loading)[.](?:gif|png)(?:$|[?#])/i.test(u.pathname);}catch{return false;}};
  if(!Number.isInteger(count)||count<1||count>10)return null;
  const rows=Array.from({length:10},(_,i)=>({url:value('ImageFullPath'+(i+1)),width:value('ImageWidth'+(i+1)),height:value('ImageHeight'+(i+1))}));
  // Yahoo can leave thumbNail empty after every photo slot has uploaded.
  const thumbnail=value('thumbNail');
  if(rows.slice(0,count).some(row=>!uploaded(row.url)||!/^\d+$/.test(row.width)||Number(row.width)<1||!/^\d+$/.test(row.height)||Number(row.height)<1)||rows.slice(count).some(row=>row.url)||new Set(rows.slice(0,count).map(row=>row.url)).size!==count||(thumbnail&&!uploaded(thumbnail)))return null;
  return JSON.stringify({photos:rows.slice(0,count),thumbnail});
 };
 const current=()=>globalThis.__bussanSellerOperation;
 function reserve(){if(current()?.id===job.id&&current()?.submitted)throw Error('この操作は送信を試行済みです。自動再送しません');globalThis.__bussanSellerOperation={...current(),id:job.id,submitted:true};}
 function tradeGuard(){const exactMercari=job.channel==='メルカリ'&&/^m[0-9]+$/.test(job.external_id||'')&&(location.pathname==='/transaction/'+job.external_id||location.pathname.startsWith('/transaction/'+job.external_id+'/'));if(!job.external_id||!job.trade_key||!exactMercari&&!text().includes(job.external_id)||!/取引画面|取引情報|取引ナビ|発送|配送/.test(text()))throw Error('対象の出品者取引を確認できません');if(/この商品を購入|購入手続きへ|受け取り評価をする|受取連絡をする/.test(controls().map(buttonLabel).join(' ')))throw Error('購入者側の操作画面のため停止しました');}
 async function waitFor(check,note,timeout=20000){const end=Date.now()+timeout;while(Date.now()<end){const result=await check();if(result)return result;if(/エラーが発生|操作に失敗|時間をおいて/.test(text()))throw Error('販売サイトがエラーを返しました');await sleep(250);}throw Error(note);}
 let qrImageRead;
 async function qrPng(){
  const named=e=>/qr|2次元|二次元|配送コード/i.test([e.id,e.getAttribute('data-testid'),e.parentElement?.getAttribute('data-testid')].filter(Boolean).join(' '))||[e.getAttribute('alt'),e.getAttribute('aria-label'),e.parentElement?.getAttribute('aria-label')].filter(Boolean).some(t=>/^(?:(?:配送用|発送用)?(?:QR|2次元|二次元)(?:コード|code)?(?:の画像)?|配送コード)$/i.test(t.replace(/\s/g,'')));
  const barcode=e=>/barcode|バーコード/i.test([e.id,e.getAttribute('data-testid'),e.parentElement?.getAttribute('data-testid')].filter(Boolean).join(' '))||[e.getAttribute('alt'),e.getAttribute('aria-label'),e.parentElement?.getAttribute('aria-label')].filter(Boolean).some(t=>/^(?:(?:配送用|発送用)?バーコード(?:の画像)?|(?:shipping)?barcode)$/i.test(t.replace(/\s/g,'')));
  const codeRoot=job.channel==='ヤフオク'&&location.hostname==='contact.auctions.yahoo.co.jp'&&location.pathname.startsWith('/trade/')?document.body:root;
  const elements=[...codeRoot.querySelectorAll('canvas,img,svg')].filter(e=>{const box=e.getBoundingClientRect();return visible(e)&&(barcode(e)?box.width>=128&&(box.height>=24||e.tagName==='IMG'&&!e.complete):box.width>=64&&(box.height>=64||e.tagName==='IMG'&&!e.complete)&&named(e));});if(!elements.length)return null;if(elements.length!==1)throw Error('配送コードの画像を1件に確認できません');const source=elements[0];
  if(source.tagName.toLowerCase()==='canvas')return source.toDataURL('image/png');
  if(source.tagName==='IMG'&&new URL(source.src).origin!==location.origin&&new URL(source.src).hostname==='api.mercari.jp'&&new URL(source.src).protocol==='https:'){
   // Read only the exact displayed QR image, once. Normal page CORS applies; no credentials are exported.
   if(!qrImageRead)qrImageRead=(async()=>{let url;try{const response=await fetch(source.src,{method:'GET',credentials:'same-origin',redirect:'error',cache:'force-cache',signal:AbortSignal.timeout(12000)});if(!response.ok||!/^image\/(png|jpeg|svg\+xml|webp)(?:;|$)/i.test(response.headers.get('content-type')||''))throw Error();const blob=await response.blob();if(blob.size>2*1024*1024)throw Error();url=URL.createObjectURL(blob);const image=new Image();image.src=url;await image.decode();const width=image.naturalWidth,height=image.naturalHeight;if(!width||!height||width>4096||height>4096)throw Error();const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;const context=canvas.getContext('2d');context.fillStyle='#fff';context.fillRect(0,0,width,height);context.drawImage(image,0,0);return canvas.toDataURL('image/png');}catch{throw Error('表示済み配送コード画像を取得できません。再発行せず停止します');}finally{if(url)URL.revokeObjectURL(url);}})();return qrImageRead;
  }
  if(source.tagName.toLowerCase()==='img'&&(!source.complete||!source.naturalWidth))return null;
  if(source.tagName.toLowerCase()==='img'&&source.src.startsWith('data:image/png;base64,'))return source.src;
  let image=source,objectUrl;
  try{
   if(source.tagName.toLowerCase()==='svg'){const copy=source.cloneNode(true),box=source.getBoundingClientRect();copy.setAttribute('xmlns','http://www.w3.org/2000/svg');copy.setAttribute('width',String(source.viewBox.baseVal.width||box.width));copy.setAttribute('height',String(source.viewBox.baseVal.height||box.height));copy.style.color=getComputedStyle(source).color;objectUrl=URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(copy)],{type:'image/svg+xml'}));image=new Image();image.src=objectUrl;await image.decode();}
   const width=image.naturalWidth,height=image.naturalHeight;if(!width||!height||width>4096||height>4096)throw Error('配送コードの画像サイズを確認できません');const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;const context=canvas.getContext('2d');context.fillStyle='#fff';context.fillRect(0,0,width,height);context.drawImage(image,0,0);return canvas.toDataURL('image/png');
  }catch{throw Error('配送コードの画像をPNGで取得できません。再発行せず停止します');}finally{if(objectUrl)URL.revokeObjectURL(objectUrl);}
 }
 const statusValues=()=>[...root.querySelectorAll('[role="status"],h1,h2,h3,p,span')].filter(e=>visible(e)&&(!e.children.length||e.getAttribute('role')==='status')).map(e=>norm(e.innerText));
 const postalMethod=()=>['ゆうパケットプラス','ゆうパケットポストmini','ゆうパケット'].includes(payload.size)?payload.size:'ゆうパック';
 const expectedValues=()=>[payload.title,payload.description,String(payload.price),payload.condition,job.channel==='ヤフオク'&&/購入者/.test(payload.shippingPayer)?'落札者':payload.shippingPayer,job.channel==='ヤフオク'?/日本郵便/.test(payload.shippingMethod)?postalMethod():payload.size==='宅急便コンパクト'?'宅急便コンパクト':'宅急便':payload.shippingMethod,payload.origin,payload.dispatchDays,...String(payload.listingCategory||payload.category).split(/\s*[>＞]\s*/)];
 function exposedTextElement(element){if(!element||getComputedStyle(element).visibility!=='visible')return false;for(let current=element;current;current=current.parentElement){const style=getComputedStyle(current);if(current.hidden||current.getAttribute('aria-hidden')==='true'||style.display==='none'||style.contentVisibility==='hidden'||style.opacity==='0')return false;}return true;}
 function confirmationSetting(name){const values=[];
  if(job.channel==='ヤフオク'&&/^\/(?:sell\/)?jp\/show\/preview$/.test(location.pathname)){
   const shown=candidates([name]).filter(exposedTextElement);
   if(shown.length>1)return null;
   if(shown.length===1){const control=shown[0];
    if(control.type==='checkbox')values.push(name==='自動再出品'?(control.checked?'1回':'0回'):(control.checked?'あり':'なし'));
    else if(control.tagName==='SELECT')values.push(norm(control.selectedOptions[0]?.text));
   }
  }
  for(const row of root.querySelectorAll('tr')){if(!exposedTextElement(row))continue;const cells=[...row.children];if(cells.length>=2&&norm(cells[0].innerText).replace(/[（(]無料[）)]/g,'')===name)values.push(norm(cells.slice(1).map(e=>e.innerText).join(' ')));}for(const label of root.querySelectorAll('dt'))if(exposedTextElement(label)&&norm(label.innerText)===name&&label.nextElementSibling?.tagName==='DD')values.push(norm(label.nextElementSibling.innerText));for(const marker of root.querySelectorAll('div,span,p,li,dt,th')){if(!exposedTextElement(marker)||norm(marker.textContent).replace(/[：:]$/,'')!==name)continue;const next=marker.nextElementSibling;if(next&&exposedTextElement(next)&&norm(next.textContent).length<60)values.push(norm(next.textContent));const group=marker.parentElement;if(group&&exposedTextElement(group)&&norm(group.textContent).length<100){const value=norm(group.textContent).replace(new RegExp('^'+name+'[：:]?\\s*'),'');if(value)values.push(value);}}if(name==='自動再出品'){const fixed=[...root.querySelectorAll('input[type=hidden][name=numResubmit]')];if(fixed.length>1||fixed.length===1&&!/^[0-9]+$/.test(fixed[0].value))return null;if(fixed.length===1)values.push(fixed[0].value+'回');}const unique=[...new Set(values.map(value=>norm(value).replace(/^[：:]\s*/,'' )).filter(value=>/^[0-9]+回$/.test(value)||['あり','する','有効','なし','しない','設定しない'].includes(value)))];if(unique.length!==1)return null;return unique[0];}
 if(phase==='prepare_listing_payer'){await choose(['送料の負担','送料負担'],payload.shippingPayer);return {ready:true};}
 if(phase==='listing_preflight'){
  const title=field(['商品名','タイトル'],['name','Title','title']),description=descriptionField();
  if((title.value&&title.value!==payload.title)||(description.value&&description.value!==payload.description)||descriptionEditor()&&norm(descriptionEditor().innerText)&&norm(descriptionEditor().innerText)!==norm(payload.description))throw Error('サイトに別の下書きがあるため上書きしません');return {ready:true};
 }
 if(phase==='prepare_listing'){
  if(!/出品|商品情報/.test(text()))throw Error('出品フォームではありません');
  let title=field(['商品名','タイトル'],['name','Title','title']),description=descriptionField(),price=field(['販売価格','開始価格','開始時の価格','価格'],['price','Price','StartPrice']);
  // Resolve every required field before setting file inputs or attempting a submit.
  for(const names of [['商品の状態','商品状態'],['送料の負担','送料負担'],['配送の方法','配送方法'],['発送元の地域','発送元','商品の所在地'],['発送までの日数','発送までの期間'],['カテゴリー','カテゴリ']]){
   const matches=candidates(names);if(!matches.length&&!choiceTrigger(names)||matches.length>1&&!matches.every(e=>e.type==='radio'&&e.name===matches[0].name))throw Error('入力欄を確認できません：'+names[0]);
  }
  if((title.value&&title.value!==payload.title)||(description.value&&description.value!==payload.description))throw Error('サイトに別の下書きがあるため上書きしません');
  if(descriptionEditor()&&norm(descriptionEditor().innerText)&&norm(descriptionEditor().innerText)!==norm(payload.description))throw Error('説明文エディターに別の下書きがあるため上書きしません');
  await choose(['送料の負担','送料負担'],payload.shippingPayer);
  if(choicesResolved){for(const value of [payload.listingCategory||payload.category,payload.condition,payload.shippingMethod])if(!text().includes(norm(value)))throw Error('別画面で選択した出品条件を確認できません');}
  else{if(!categoryResolved)await choose(['カテゴリー','カテゴリ'],payload.listingCategory||payload.category);await choose(['商品の状態','商品状態'],payload.condition);await choose(['配送の方法','配送方法'],payload.shippingMethod);}
  await choose(['発送元の地域','発送元','商品の所在地'],payload.origin);await choose(['発送までの日数','発送までの期間'],payload.dispatchDays);
  let auctionOptionsConfirmed=true;
  if(job.channel==='ヤフオク'){
   if(/日本郵便/.test(payload.shippingMethod)&&/^\d+$/.test(String(payload.size))){if(!/購入者|落札者/.test(payload.shippingPayer)||candidates(['配送サイズ'],['ship_delivery_yupack_size_select']).length){if(!['2','5','10','15','20','25'].includes(String(payload.weightKg)))throw Error('梱包後の重さを選択してください');await choose(['配送サイズ'],payload.size+'cm以内',['ship_delivery_yupack_size_select']);await choose(['配送重量'],payload.weightKg+'kg以内',['ship_delivery_yupack_weight_select']);}}
   else if(/ヤマト運輸/.test(payload.shippingMethod)){if(!['100','140','宅急便コンパクト'].includes(String(payload.size)))throw Error('ヤマト運輸の配送サイズを選択してください');}
   else if(!['ゆうパケットプラス','ゆうパケットポストmini','ゆうパケット'].includes(payload.size))throw Error('ヤフオクの配送サイズを選択してください');
   const auction=root.querySelector('input[name="salesmode"][value="auction"]');if(auction&&!auction.checked){auction.click();if(!auction.checked)throw Error('オークション形式を確認できません');}
   const end=new Date(Date.now()+Number(payload.auctionDays)*86400000),date=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(end);
   await choose(['終了日','開催期間'],date,['ClosingYMD','ClosingDate']);await choose(['終了時間','終了時刻'],Number(payload.closingHour),['ClosingTime']);
   if(candidates(['自動延長']).length)checkbox(['自動延長'],payload.autoExtend===true);else{if(payload.autoExtend!==true)throw Error('この画面では自動延長を変更できません');auctionOptionsConfirmed=false;}
   if(candidates(['自動再出品']).length){const relist=field(['自動再出品']);if(relist.type==='checkbox'){if(relist.checked!==payload.autoRelist)relist.click();}else await choose(['自動再出品'],payload.autoRelist?'1回':'0回');}else{if(payload.autoRelist!==false)throw Error('この画面では自動再出品を変更できません');auctionOptionsConfirmed=false;}
  }else{
   const fixed=root.querySelector('input[name="listingType"][value="setPrice"]');if(fixed&&!fixed.checked){fixed.click();if(!fixed.checked)throw Error('価格設定方式を確認できません');}
  }
  title=field(['商品名','タイトル'],['name','Title','title']);description=descriptionField();price=field(['販売価格','開始価格','開始時の価格','価格'],['price','Price','StartPrice']);
  setValue(title,payload.title);setDescription(description,payload.description);setValue(price,payload.price);
  const inputs=[...root.querySelectorAll('input[type="file"]')].filter(input=>!input.disabled&&(!input.accept||/image/.test(input.accept)));const multiple=inputs.filter(input=>input.multiple);if(inputs.length!==1){if(multiple.length!==1)throw Error('写真の追加欄を1件に確認できません');inputs.splice(0,inputs.length,multiple[0]);}
  const photoZone=job.channel==='ヤフオク'?root.querySelector('#ImageList'):inputs[0].closest('section')||inputs[0].closest('[data-testid*="photo"],[data-testid*="image"],[aria-label*="画像"],[aria-label*="写真"]')||inputs[0].parentElement;
  if(!photoZone)throw Error('出品写真の表示領域を確認できません');
  if([...photoZone.querySelectorAll('img')].some(image=>visible(image)&&/blob:|data:image|photo|image|mercari|yahoo/i.test(image.src)))throw Error('既存の出品写真があるため上書きしません');
  if(!files.length||files.length>10)throw Error('出品写真を確認してください');const transfer=new DataTransfer();for(const file of files)transfer.items.add(new File([new Uint8Array(file.bytes)],file.name,{type:file.type}));inputs[0].files=transfer.files;inputs[0].dispatchEvent(new Event('change',{bubbles:true}));

  await waitFor(()=>{const images=[...photoZone.querySelectorAll('img')].filter(image=>visible(image)&&image.complete&&image.naturalWidth>0&&/blob:|data:image|photo|image|mercari|yahoo/i.test(image.src)&&!/削除|回転|拡大/.test(image.alt));const count=job.channel==='ヤフオク'?new Set(images.map(image=>image.closest('li')).filter(Boolean)).size:images.length;return !root.querySelector('[aria-busy="true"]')&&!/アップロード中|画像を処理中/.test(text())&&count===files.length&&(job.channel!=='ヤフオク'||yahooPhotoSignature(files.length)!==null);},'写真のアップロード完了を確認できません',job.channel==='ヤフオク'?90000:20000);
  if(title.value!==payload.title||descriptionField().value!==payload.description||Number(price.value)!==payload.price||descriptionEditor()&&norm(descriptionEditor().innerText)!==norm(payload.description))throw Error('出品内容が入力値と一致しません');
  if(job.channel==='ヤフオク'&&controls().some(e=>['確認画面へ','確認する','出品内容を確認する'].includes(buttonLabel(e))))await waitFor(()=>{const buttons=controls().filter(e=>['確認画面へ','確認する','出品内容を確認する'].includes(buttonLabel(e)));return buttons.length===1&&!buttons[0].disabled;},'出品内容の確認ボタンが有効になりません',20000);
  globalThis.__bussanSellerOperation={id:job.id,submitted:false,signature:formSignature(),photoZone,photos:imageSignature(photoZone),photoCount:files.length,uploadedPhotos:yahooPhotoSignature(files.length),expected:expectedValues(),title,description:descriptionField(),price,auctionOptionsConfirmed};return {prepared:true};
 }
 if(phase==='preview_listing'){
  const prepared=current();if(prepared?.id!==job.id||prepared.submitted||prepared.signature!==formSignature()||!prepared.photoZone?.isConnected||prepared.photos!==imageSignature(prepared.photoZone)||job.channel==='ヤフオク'&&prepared.uploadedPhotos!==yahooPhotoSignature(prepared.photoCount))throw Error('出品確認前の入力内容が変更されています');
  const confirm=controls().filter(e=>['確認画面へ','確認する','出品内容を確認する'].includes(buttonLabel(e)));if(confirm.length>1)throw Error('確認画面への入口が曖昧です');if(confirm.length===1){if(confirm[0].disabled)throw Error('出品内容の確認ボタンが無効です');setTimeout(()=>confirm[0].click(),100);return {confirmation_requested:true};}
  return {prepared:true,stoppedBeforePublish:true,photoCount:files.length||prepared.photoZone.querySelectorAll('img').length};
 }
 if(phase==='publish'){
  const prepared=current();if(prepared?.id!==job.id||prepared.submitted||prepared.signature!==formSignature()||!prepared.photoZone?.isConnected||prepared.photos!==imageSignature(prepared.photoZone)||job.channel==='ヤフオク'&&prepared.uploadedPhotos!==yahooPhotoSignature(prepared.photoCount)||prepared.title.value!==payload.title||prepared.description.value!==payload.description||Number(prepared.price.value)!==payload.price)throw Error('出品直前の内容を確認できません');
  const forms=[...root.querySelectorAll('form')].filter(visible);if(forms.some(form=>!form.checkValidity()))throw Error('出品に必要な項目が不足しています');
  const confirm=controls().filter(e=>['確認画面へ','確認する','出品内容を確認する'].includes(buttonLabel(e)));
  if(confirm.length===1){if(confirm[0].disabled)throw Error('出品内容の確認ボタンが無効です');setTimeout(()=>confirm[0].click(),100);return {confirmation:true,confirmationStep:location.pathname+'|initial'};}
  if(job.channel==='ヤフオク'&&!prepared.auctionOptionsConfirmed)throw Error('自動延長・再出品の設定を確認できません。出品は送信しません');
  const button=oneButton(['出品する','出品']);reserve();button.click();return {submitted:true};
 }
 if(phase==='publish_confirmation'||phase==='check_listing_confirmation'){
  if(job.channel==='ヤフオク'&&/^\/(?:sell\/)?jp\/show\/preview$/.test(location.pathname))root=document.body;
  if(!/確認|出品/.test(text()))throw Error('出品の確認画面ではありません');
  const validationErrors=[...root.querySelectorAll('[role=alert],[class*=error i]')].filter(visible).map(e=>norm(e.innerText)).filter(t=>t&&t.length<500);
  const duplicate=validationErrors.find(t=>t.includes('すでに同じタイトルのオークションが出品されています'));
  if(duplicate){const error=new Error('同じタイトルの出品があるため、出品結果を確認してください。再出品はしていません');error.stoppedBeforePublish=true;error.existingListing=true;throw error;}
  const frames=[...root.querySelectorAll('iframe')].flatMap(frame=>{try{return [frame.contentDocument?.body?.innerText||''];}catch{return [];}}).join(' ');
  const rendered=[],walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let node;while((node=walker.nextNode())){const parent=node.parentElement;if(parent&&!/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(parent.tagName)&&exposedTextElement(parent)&&norm(node.textContent))rendered.push(node.textContent);}
  const normalized=choiceText(rendered.join(' ')+' '+frames).replaceAll(',','');
  const editablePreview=job.channel==='ヤフオク'&&/^\/(?:sell\/)?jp\/show\/preview$/.test(location.pathname);
  function matchesConfirmation(value,index){
   // Yahoo's preview retains visible Title/StartPrice inputs. Their values are
   // not text nodes. Hidden backing fields cannot prove what the user sees.
   if(editablePreview&&(index===0||index===2)){
    const selector=index===0?'input[name=Title],input[name=title]':'input[name=StartPrice]';
    const inputs=[...root.querySelectorAll(selector)].filter(e=>visible(e)&&exposedTextElement(e)&&e.type!=='hidden');
    if(inputs.length){
     if(inputs.length!==1)return false;
     const actual=inputs[0].value;
     return index===0?norm(actual)===norm(value):/^[0-9]+(?:,[0-9]{3})*$/.test(actual)&&actual.replaceAll(',','')===String(value);
    }
   }
   return normalized.includes(choiceText(value).replaceAll(',',''));
  }
  const missing=expectedValues().flatMap((value,index)=>matchesConfirmation(value,index)?[]:[['商品名','説明文','価格','商品状態','送料負担','配送方法','発送元','発送日数'][index]||'カテゴリ']);if(missing.length){
   const error=new Error('確認画面で出品内容が一致しません：'+missing.join('・'));
   const pageText=choiceText(document.body.innerText).replaceAll(',','');
   error.stoppedBeforePublish=true;
   error.confirmationEvidence={path:location.pathname,root:root.tagName,missing,
    expectedTitle:payload.title,expectedPrice:String(payload.price),
    pageTitleMatches:pageText.includes(choiceText(payload.title)),pagePriceMatches:pageText.includes(String(payload.price)),
    titleFields:[...document.querySelectorAll('input[name=Title],input[name=title],input[name=name]')].filter(visible).map(e=>norm(e.value).slice(0,180)).slice(0,3),
    priceFields:[...document.querySelectorAll('input[name=StartPrice],input[name=price]')].filter(visible).map(e=>norm(e.value).slice(0,20)).slice(0,3),
    headings:[...document.querySelectorAll('h1,h2,h3')].filter(visible).map(e=>norm(e.innerText).slice(0,180)).slice(0,8),
    prices:[...document.body.innerText.matchAll(/[0-9０-９][0-9０-９,，]*\s*円/g)].slice(0,12).map(m=>m[0])};
   throw error;
  }
  const finalNames=['出品する','ガイドラインに同意して出品する','上記のガイドライン、規約、情報提供等に同意して 出品する'];
  const intermediate=controls().filter(e=>['確認画面へ','確認する','出品内容を確認する'].includes(buttonLabel(e)));
  if(editablePreview&&intermediate.length===1&&!controls().some(e=>finalNames.includes(buttonLabel(e)))){
   const step=location.pathname+'|'+root.querySelectorAll('input,select,textarea').length+'|'+text().length;
   if(phase==='check_listing_confirmation')return {verified:false,stoppedBeforePublish:true,intermediateConfirmation:true};
   if(intermediate[0].disabled||confirmationSteps.includes(step)){const error=new Error('出品の入力確認画面が進まないため確定前に停止しました');error.stoppedBeforePublish=true;throw error;}
   setTimeout(()=>intermediate[0].click(),100);return {confirmation:true,confirmationStep:step};
  }
  if(job.channel==='ヤフオク'&&(!['あり','する','有効'].includes(confirmationSetting('自動延長'))||!['なし','しない','0回','設定しない'].includes(confirmationSetting('自動再出品')))){const error=new Error('確認画面で自動延長あり・自動再出品なしを確認できません。出品は送信しません');error.stoppedBeforePublish=true;error.confirmationEvidence={path:location.pathname,autoExtend:confirmationSetting('自動延長'),autoRelist:confirmationSetting('自動再出品'),controls:['自動延長','自動再出品'].flatMap(name=>candidates([name]).map(e=>({label:name,type:e.type,checked:e.type==='checkbox'?e.checked:undefined,selected:e.tagName==='SELECT'?e.selectedOptions[0]?.text:undefined})))};throw error;}
  if(phase==='check_listing_confirmation')return {verified:true,stoppedBeforePublish:true};
  const button=oneButton(['出品する','ガイドラインに同意して出品する','上記のガイドライン、規約、情報提供等に同意して 出品する']);reserve();button.click();return {submitted:true};
 }
 if(phase==='listing_ended'){
  const direct=location.href.match(/^https:\/\/(?:page[.])?auctions[.]yahoo[.]co[.]jp\/jp\/auction\/([a-z][0-9]+)(?:[/?#]|$)/i)?.[1];
  const noBids=[...root.querySelectorAll('a[href]')].some(a=>{try{const u=new URL(a.href);return u.protocol==='https:'&&['auctions.yahoo.co.jp','page.auctions.yahoo.co.jp'].includes(u.hostname)&&u.pathname==='/jp/show/bid_hist'&&u.searchParams.get('aID')===job.external_id&&/^0\s*件$/.test(norm(a.innerText));}catch{return false;}});
  if(job.channel!=='ヤフオク'||!direct||direct!==job.external_id||!/このオークションは終了しています/.test(text())||!noBids)throw Error('対象の出品終了・入札なしを確認できません');
  return {external_id:direct,url:'https://page.auctions.yahoo.co.jp/jp/auction/'+direct,observed_at:new Date().toISOString(),ended_without_sale:true,bid_count:0};
 }
 if(phase==='listing_result'){
  return await waitFor(()=>{
   const direct=job.channel==='メルカリ'?location.href.match(/^https:\/\/jp[.]mercari[.]com\/item\/(m[0-9]+)/):location.href.match(/^https:\/\/(?:page[.])?auctions[.]yahoo[.]co[.]jp\/jp\/auction\/([a-z][0-9]+)/i);
   let id=direct?.[1];if(!id&&/出品が完了|出品しました|出品完了/.test(text())){const links=[...(document.querySelector('main')||document.body).querySelectorAll('a[href]')].map(a=>a.href.match(job.channel==='メルカリ'?/^https:\/\/jp[.]mercari[.]com\/item\/(m[0-9]+)/:/^https:\/\/(?:page[.])?auctions[.]yahoo[.]co[.]jp\/jp\/auction\/([a-z][0-9]+)/i)).filter(Boolean);const ids=new Set(links.map(value=>value[1]));if(ids.size===1)id=[...ids][0];}
   if(!id)return null;
   return {observed_at:new Date().toISOString(),external_id:id,url:job.channel==='メルカリ'?'https://jp.mercari.com/item/'+id:'https://page.auctions.yahoo.co.jp/jp/auction/'+id};
  },'出品結果を確認できません。サイトで確認するまで再実行しません');
 }
 // A completed document can still contain Mercari's loading shell. Wait for the exact trade's shipping controls before its first guard; never click while waiting.
 if(phase==='shipping_preflight'&&job.channel==='メルカリ'){
  if(location.pathname!=='/transaction/'+job.external_id)throw Error('対象取引の発送画面ではありません');
  await waitFor(()=>{root=document.querySelector('main')||document.body;return /取引画面|取引情報|発送|配送/.test(text())&&controls().some(e=>['商品サイズと発送場所を選択する','配送用の2次元コードを表示する','配送用QRコードを表示','2次元コードを発行する','QRコードを表示','発送用QRコードを発行','発送用バーコードを発行','発送用2次元コードを発行'].includes(buttonLabel(e)));},'取引画面の発送情報の読み込みが時間切れになりました。コードは発行していません');
 }
 if(phase==='ship_notice_preflight'){
  if(job.channel==='メルカリ'&&location.pathname!=='/transaction/'+job.external_id)throw Error('対象取引の発送通知画面ではありません');
  let completedSince=0;
  await waitFor(()=>{root=document.body;if(noticeButtons().some(e=>!e.disabled||job.channel==='ヤフオク'&&[...root.querySelectorAll('input[type=checkbox]')].some(c=>visible(c)&&/商品を発送しました/.test(label(c)))))return true;if(!shippingNoticeCompleted()){completedSince=0;return false;}if(!completedSince)completedSince=Date.now();return Date.now()-completedSince>=1000;},'発送通知ボタンの表示を確認できません。通知は送信していません');
  tradeGuard();return shippingNoticeCompleted()?{ready:true,alreadyNotified:true,observed_at:new Date().toISOString()}:{ready:true};
 }
 tradeGuard();
 if(phase==='yahoo_shipping_preflight'){
  if(job.channel!=='ヤフオク'||location.hostname!=='contact.auctions.yahoo.co.jp'||!location.pathname.startsWith('/trade/')||new URL(location.href).searchParams.get('aid')!==job.external_id)throw Error('対象のヤフオク出品者取引ではありません');
  if(await qrPng()||/配送コードを発行してください/.test(text()))return {ready:true};
  const tabs=[...root.querySelectorAll('a[href]')].filter(e=>visible(e)&&buttonLabel(e)==='取引'&&e.origin===location.origin&&e.pathname.startsWith('/trade/')&&new URL(e.href).searchParams.get('aid')===job.external_id&&e.href!==location.href);
  if(tabs.length!==1)throw Error('発送操作のある取引タブを1件に確認できません');
  return {trade_tab_url:tabs[0].href};
 }
 if(phase==='read_shipping_code'){try{return {qr_code:waitForShippingCode?await waitFor(qrPng,'配送コードの画像を確認できません。再発行しません'):await qrPng()};}catch(error){return {__error:error.message};}}
 if(phase==='shipping_preflight'){
  if(job.channel==='メルカリ'&&payload.dropoff){const postal=/ゆうゆう/.test(payload.shippingMethod||'');if(!(postal?['ローソン','郵便局']:['セブンイレブン','ヤマト営業所']).includes(payload.dropoff))throw Error('配送方法と発送場所が一致しません。ゆうゆうメルカリ便はローソン・郵便局、らくらくメルカリ便はセブンイレブン・ヤマト営業所を選択してください');}
  const entries=controls().filter(e=>buttonLabel(e)==='商品サイズと発送場所を選択する'),edit=[...root.querySelectorAll('a[href]')].filter(e=>visible(e)&&e.origin===location.origin&&e.pathname==='/transaction/'+job.external_id+'/shipping_class');if(entries.length+edit.length>1)throw Error('配送設定の入口が曖昧です');if(payload.shippingMethod&&!text().includes(norm(payload.shippingMethod)))throw Error('サイトの配送方法がアプリの設定と一致しません');
  const codes=controls().filter(e=>['配送用の2次元コードを表示する','配送用QRコードを表示','2次元コードを発行する','QRコードを表示','発送用QRコードを発行','発送用バーコードを発行','発送用2次元コードを発行'].includes(buttonLabel(e)));if(codes.length>1)throw Error('配送QRの発行ボタンが曖昧です');const place=controls().map(buttonLabel).map(t=>t.replace(/[\s\-−–]/g,''));const configuredDropoff=place.includes('ヤマト運輸営業所からの発送方法')?'ヤマト営業所':place.includes('セブンイレブンからの発送方法')?'セブンイレブン':place.includes('ローソンからの発送方法')?'ローソン':null;return {needsEditor:entries.length+edit.length===1,readyForCode:codes.length===1,configuredDropoff};
 }
 if(phase==='message_sync'){
  const nodes=[...root.querySelectorAll('[data-testid*="message" i],[class*="message" i]')].filter(e=>visible(e)&&!e.matches('textarea,input,button,form')&&norm(e.innerText)&&![...e.querySelectorAll('[data-testid*="message" i],[class*="message" i]')].some(child=>visible(child)&&norm(child.innerText).length>10));
  const messages=nodes.map(e=>({body:norm(e.innerText).slice(0,10000)})).filter(value=>value.body).slice(-100);return {messages,attention:messages.some(value=>/キャンセル|中止/.test(value.body))};
 }
 if(phase==='message_send'){
  const candidates=[...root.querySelectorAll('form')].filter(visible).map(form=>({form,fields:[...form.querySelectorAll('textarea')].filter(visible),buttons:[...form.querySelectorAll('button,input[type="submit"]')].filter(visible)})).filter(value=>value.fields.length===1&&value.buttons.length===1&&/メッセージ|取引連絡|コメント/.test(label(value.fields[0])+' '+buttonLabel(value.buttons[0]))&&/^(送信|送る|投稿|メッセージを送信する|取引メッセージを送信)$/.test(buttonLabel(value.buttons[0])));
  if(candidates.length!==1)throw Error('取引メッセージの送信欄を1件に確認できません');const {fields:[input],buttons:[button]}=candidates[0];if(input.value)throw Error('入力済みの文章があるため停止しました');setValue(input,payload.body);tradeGuard();reserve();button.click();await waitFor(()=>input.value===''&&text().includes(norm(payload.body)),'送信結果を確認できません。再送しません');return {sent:true,note:'メッセージを送信しました'};
 }
 if(phase==='verify_shipping'){const accepted=[...root.querySelectorAll('[role="status"],[data-testid="shipping-status"],[data-testid="delivery-status"]')].filter(visible).some(element=>/^(店舗で受付済み|受付完了|荷物受付|発送済み|配送中|発送通知をしました)$/.test(norm(element.innerText)));return {accepted,note:accepted?'受付を確認しました':'店舗での受付はまだ確認できません'};}
 if(phase==='shipping_code'){
  if((/ローソン/.test(payload.dropoff)&&!/日本郵便|ゆうゆう/.test(payload.shippingMethod))||(/宅急便コンパクト/.test(payload.size)&&/日本郵便|ゆうゆう/.test(payload.shippingMethod)))throw Error('配送方法・サイズ・発送場所の組み合わせを確認してください');
  const existing=await qrPng();if(existing)return {qr_code:existing};
  if(shippingPrepared){if(job.channel!=='メルカリ'||location.pathname!=='/transaction/'+job.external_id)throw Error('配送設定後の取引画面ではありません');const name=field(['品名','商品名'],['itemName']);if(name.readOnly||name.disabled)throw Error('配送用の商品名を入力できません');await choose(['品名','商品名'],payload.category,['itemName']);}
  else{
   let fixedSize=false;
   if(job.channel==='ヤフオク'&&!candidates(['サイズ','配送サイズ']).length){
    const summaries=[...root.querySelectorAll('table')].filter(table=>[...table.querySelectorAll('th')].some(e=>e.closest('table')===table&&norm(e.innerText)==='落札者が選択した配送方法'));
    const methods=summaries.flatMap(table=>[...table.querySelectorAll('td')].filter(e=>e.closest('table')===table).map(e=>norm(e.innerText)));
    const expected=norm(payload.shippingMethod).replace(/\s/g,''),sizes=methods.filter(t=>t.replace(/\s/g,'').includes(expected)).flatMap(t=>[...t.matchAll(/(?:ゆうパック|宅急便(?:[（(]EAZY[）)])?)\s*([0-9]{2,3})\s*サイズ/g)].map(m=>m[1]));
    if(!/配送コードを発行してください/.test(text())||sizes.length!==1||sizes[0]!==String(payload.size))throw Error('落札者が選択した配送サイズとアプリ設定の一致を確認できません');
    fixedSize=true;
   }
   if(!fixedSize)await choose(['サイズ','配送サイズ'],payload.size);
   const nativePostal=fixedSize&&payload.shippingMethod==='おてがる配送（日本郵便）'&&!candidates(['発送場所','発送する場所']).length;
   if(nativePostal){
    oneButton(['配送コードを発行する']);
    const named=candidates(['品名','商品名']),inputs=named.length?named:fields().filter(e=>e.tagName==='INPUT'&&e.type==='text'&&/^例[：:]\s*家電製品→/.test(norm(e.getAttribute('placeholder'))));
    if(inputs.length!==1||inputs[0].readOnly||inputs[0].disabled||!payload.category||[...String(payload.category)].length>17)throw Error('配送用の品名入力欄を1件に確認できません');
    setValue(inputs[0],payload.category);
   }else{await choose(['発送場所','発送する場所'],payload.dropoff);await choose(['品名','商品名'],payload.category);}
  }
  const button=oneButton(['配送用の2次元コードを表示する','配送用QRコードを表示','2次元コードを発行する','QRコードを表示','発送用QRコードを発行','発送用バーコードを発行','発送用2次元コードを発行',...(job.channel==='ヤフオク'?['配送コードを発行する']:[])]);reserve();setTimeout(()=>button.click(),100);return {code_requested:true};
 }
 if(phase==='register_package'){
  if(!/ゆうパケットポスト/.test(text()))throw Error('専用資材を使用する発送画面ではありません');
  const input=field(['発送用コード','2次元コード','専用資材コード','ポスト発送確認用番号']);setValue(input,payload.code);const button=oneButton(['登録する','コードを登録','読み取り内容を登録']);reserve();button.click();await waitFor(()=>statusValues().some(value=>/^(登録完了|読み取り完了|登録が完了しました|読み取りが完了しました)$/.test(value)),'専用資材の登録結果を確認できません');return {registered:true,note:'専用資材を対象取引へ登録しました'};
 }
 if(phase==='ship_notice'){
  if(payload.automatic_receipt){const proof=payload.automatic_receipt;
   const shown=[...root.querySelectorAll('p,span,div,dt,dd,td,th')].filter(e=>visible(e)&&!e.children.length&&!e.closest('button,textarea')).filter(e=>{const h=[...root.querySelectorAll('h2,h3')].filter(h=>visible(h)&&(h.compareDocumentPosition(e)&Node.DOCUMENT_POSITION_FOLLOWING)).at(-1);return !h||!/メッセージ|コメント/.test(h.innerText);}).map(e=>norm(e.innerText)).join(' ').normalize('NFKC');
   const numbers=new Set([...shown.matchAll(/(?:送り状番号|お問い合わせ番号|お問合せ番号|追跡番号|伝票番号)\s*[:：]?\s*([0-9][0-9 -]{9,18}[0-9])/g)].map(m=>m[1].replace(/\D/g,'')));
   if(proof.accepted!==true||!/^\d{11,13}$/.test(proof.tracking_number||'')||!Number.isFinite(Date.parse(proof.observed_at))||Date.now()-Date.parse(proof.observed_at)>300000||Date.parse(proof.observed_at)>Date.now()+30000||numbers.size!==1||!numbers.has(proof.tracking_number))throw Error('現在の荷物の引受根拠を確認できません。通知していません');
  }
  if(job.channel==='ヤフオク'){const checks=fields().filter(e=>e.type==='checkbox'&&/商品を発送しました/.test(label(e)));if(checks.length>1)throw Error('発送確認のチェック欄を確定できません');if(checks.length===1&&!checks[0].checked)checks[0].click();}
  const buttons=noticeButtons();if(buttons.length!==1||buttons[0].disabled)throw Error('発送通知ボタンを1件に確認できません');const button=buttons[0];reserve();button.click();let confirmed=false;
  const sentValues=()=>[...root.querySelectorAll('[role=status],h1,h2,h3,p,span')].filter(e=>visible(e)&&(!e.children.length||e.getAttribute('role')==='status')&&!e.closest('button,a')).filter(e=>{const h=[...root.querySelectorAll('h2,h3')].filter(h=>visible(h)&&(h.compareDocumentPosition(e)&Node.DOCUMENT_POSITION_FOLLOWING)).at(-1);return !h||!/メッセージ|コメント/.test(norm(h.innerText));}).map(e=>norm(e.innerText));

  try{await waitFor(()=>{
   root=document.querySelector('main')||document.body;
   const completed=sentValues().some(value=>/^(発送通知をしました|発送通知が完了しました|商品の発送を通知しました|発送を通知しました|発送通知を送信しました|発送済み|配送中)$/.test(value)||/^(?:購入者(?:から|の)?の?)?受取評価(?:を|が|の)?(?:お待ちください|待ち|待っています)[。.]?$/.test(value));
   if((completed||confirmed&&shippingNoticeCompleted())&&(!button.isConnected||button.disabled))return true;
   const dialogs=[...document.querySelectorAll('[role=dialog],[aria-modal=true]')].filter(e=>visible(e)&&exposedTextElement(e)&&/発送/.test(e.innerText)&&!e.querySelector('textarea'));
   if(!confirmed&&dialogs.length===1){
    const matches=[...dialogs[0].querySelectorAll('button,input[type=submit]')].filter(e=>visible(e)&&!e.disabled&&['発送を通知する','発送通知をする','発送したことを通知する','商品を発送したので、発送通知をする','発送しました','通知する','はい'].includes(buttonLabel(e)));
    if(matches.length===1){tradeGuard();confirmed=true;matches[0].click();}
   }
   return false;
  },'発送通知の結果を確認できません。再送しません');}
  catch(error){error.shippingEvidence={confirmationClicked:confirmed,dialogButtons:[...document.querySelectorAll('[role=dialog] button,[aria-modal=true] button')].filter(visible).map(buttonLabel).slice(0,8),status:sentValues().filter(v=>v.length<160&&/発送|配送|受取評価/.test(v)).slice(0,8)};throw error;}
  return {notified:true,note:'発送通知を送信しました'};
 }
 throw Error('未対応の販売サイト操作です');
 }catch(error){if(reportErrors)return {__error:error.message,...(error.existingListing?{existingListing:true}:{}),...(error.stoppedBeforePublish?{stoppedBeforePublish:true,confirmationEvidence:error.confirmationEvidence}:{}),...(error.shippingEvidence?{shippingEvidence:error.shippingEvidence}:{})};throw error;}
}


