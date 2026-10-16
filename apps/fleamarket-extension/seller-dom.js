/** Executed in an isolated extension world. Unknown/ambiguous controls stop before submission. */
export async function sellerDomOperation({job,phase,files=[],categoryResolved=false}){
 const norm=value=>String(value??'').replace(/\s+/g,' ').trim(),visible=e=>!!e&&e.getClientRects().length>0&&getComputedStyle(e).visibility!=='hidden';
 let root=document.querySelector('main')||document.body;const text=()=>norm((document.querySelector('main')||document.body).innerText),payload=job.payload;
 const hosts=job.channel==='メルカリ'?['jp.mercari.com']:['auctions.yahoo.co.jp','page.auctions.yahoo.co.jp','contact.auctions.yahoo.co.jp','buy.auctions.yahoo.co.jp'];
 if(location.protocol!=='https:'||!hosts.includes(location.hostname)||document.querySelector('input[type="password"],input[autocomplete="one-time-code"]')||/文字認証|認証コードを入力|ロボットではない|セキュリティチェック/.test(text()))throw Error('販売サイトへのログイン・追加認証が必要です');
 const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 const controls=()=>[...root.querySelectorAll('button,input[type="submit"],input[type="button"],[role="button"]')].filter(visible);
 const buttonLabel=e=>norm(e.innerText||e.getAttribute('aria-label')||e.value);
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
 function setDescription(target,value){const editor=descriptionEditor();if(editor){editor.replaceChildren(editor.ownerDocument.createTextNode(value));editor.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:value}));editor.dispatchEvent(new Event('change',{bubbles:true}));}setValue(target,value);}
 const choiceText=value=>norm(value).replace(/[（）()・\s]/g,'').replace(/[〜～~]/g,'-');
 const choiceNames=names=>/カテゴリ/.test(names.join(' '))?['カテゴリーを選択する','カテゴリを選択する']:/状態/.test(names[0])?['商品の状態を選択する']:/配送/.test(names[0])?['配送の方法を選択する']:[];
 function choiceTrigger(names){const labels=choiceNames(names);const options=[...root.querySelectorAll('a,button,input[type="button"]')].filter(e=>visible(e)&&(labels.includes(buttonLabel(e))||/カテゴリ/.test(names.join(' '))&&e.id==='acMdCateChange'));if(options.length!==1)return null;return options[0];}
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
    if(e.name==='shipmethod_dummy'&&/ヤマト運輸/.test(value))return /^宅急便[（(]EAZY[）)].*60[〜～-]160/.test(label(e));
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
  });if(options.length!==1)throw Error('選択肢を1件に確認できません：'+names[0]);setValue(target,options[0].value);return target;}
  if(target.tagName==='INPUT'&&target.type!=='radio'){setValue(target,value);return target;}
  throw Error('選択欄の形式に対応していません：'+names[0]);
 }
 function checkbox(names,checked){const target=field(names);if(target.type!=='checkbox')throw Error('チェック欄の形式に対応していません');if(target.checked!==checked)target.click();if(target.checked!==checked)throw Error('チェックの結果を確認できません');}
 const formSignature=()=>JSON.stringify({fields:fields().map(e=>({id:e.id,name:e.name,label:label(e),value:e.value,checked:e.type==='checkbox'||e.type==='radio'?e.checked:null})),editor:descriptionEditor()?.innerText??null});
 const imageSignature=zone=>JSON.stringify([...zone.querySelectorAll('img')].filter(visible).map(image=>image.src));
 const current=()=>globalThis.__bussanSellerOperation;
 function reserve(){if(current()?.id===job.id&&current()?.submitted)throw Error('この操作は送信を試行済みです。自動再送しません');globalThis.__bussanSellerOperation={...current(),id:job.id,submitted:true};}
 function tradeGuard(){if(!job.external_id||!job.trade_key||!text().includes(job.external_id)||!/取引画面|取引情報|取引ナビ|発送|配送/.test(text()))throw Error('対象の出品者取引を確認できません');if(/この商品を購入|購入手続きへ|受け取り評価をする|受取連絡をする/.test(controls().map(buttonLabel).join(' ')))throw Error('購入者側の操作画面のため停止しました');}
 async function waitFor(check,note,timeout=20000){const end=Date.now()+timeout;while(Date.now()<end){const result=check();if(result)return result;if(/エラーが発生|操作に失敗|時間をおいて/.test(text()))throw Error('販売サイトがエラーを返しました');await sleep(250);}throw Error(note);}
 const statusValues=()=>[...root.querySelectorAll('[role="status"],h1,h2,h3,p,span')].filter(e=>visible(e)&&(!e.children.length||e.getAttribute('role')==='status')).map(e=>norm(e.innerText));
 const postalMethod=()=>['ゆうパケットプラス','ゆうパケットポストmini','ゆうパケット'].includes(payload.size)?payload.size:'ゆうパック';
 const expectedValues=()=>[payload.title,payload.description,String(payload.price),payload.condition,job.channel==='ヤフオク'&&/購入者/.test(payload.shippingPayer)?'落札者':payload.shippingPayer,job.channel==='ヤフオク'&&/日本郵便/.test(payload.shippingMethod)?postalMethod():payload.shippingMethod,payload.origin,payload.dispatchDays,...String(payload.listingCategory||payload.category).split(/\s*[>＞]\s*/)];
 function confirmationSetting(name){const values=[];for(const row of root.querySelectorAll('tr')){const cells=[...row.children];if(cells.length>=2&&norm(cells[0].innerText).replace(/[（(]無料[）)]/g,'')===name)values.push(norm(cells.slice(1).map(e=>e.innerText).join(' ')));}for(const label of root.querySelectorAll('dt'))if(norm(label.innerText)===name&&label.nextElementSibling?.tagName==='DD')values.push(norm(label.nextElementSibling.innerText));if(values.length!==1)return null;return values[0];}
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
  if(!categoryResolved)await choose(['カテゴリー','カテゴリ'],payload.listingCategory||payload.category);
  await choose(['商品の状態','商品状態'],payload.condition);await choose(['送料の負担','送料負担'],payload.shippingPayer);await choose(['配送の方法','配送方法'],payload.shippingMethod);await choose(['発送元の地域','発送元','商品の所在地'],payload.origin);await choose(['発送までの日数','発送までの期間'],payload.dispatchDays);
  let auctionOptionsConfirmed=true;
  if(job.channel==='ヤフオク'){
   if(/日本郵便/.test(payload.shippingMethod)&&/^\d+$/.test(String(payload.size))){if(!['2','5','10','15','20','25'].includes(String(payload.weightKg)))throw Error('梱包後の重さを選択してください');await choose(['配送サイズ'],payload.size+'cm以内',['ship_delivery_yupack_size_select']);await choose(['配送重量'],payload.weightKg+'kg以内',['ship_delivery_yupack_weight_select']);}
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
  await waitFor(()=>{const images=[...photoZone.querySelectorAll('img')].filter(image=>visible(image)&&image.complete&&image.naturalWidth>0&&/blob:|data:image|photo|image|mercari|yahoo/i.test(image.src)&&!/削除|回転|拡大/.test(image.alt));const count=job.channel==='ヤフオク'?new Set(images.map(image=>image.closest('li')).filter(Boolean)).size:images.length;return !root.querySelector('[aria-busy="true"]')&&!/アップロード中|画像を処理中/.test(text())&&count===files.length;},'写真のアップロード完了を確認できません');
  if(title.value!==payload.title||descriptionField().value!==payload.description||Number(price.value)!==payload.price||descriptionEditor()&&norm(descriptionEditor().innerText)!==norm(payload.description))throw Error('出品内容が入力値と一致しません');
  globalThis.__bussanSellerOperation={id:job.id,submitted:false,signature:formSignature(),photoZone,photos:imageSignature(photoZone),expected:expectedValues(),title,description:descriptionField(),price,auctionOptionsConfirmed};return {prepared:true};
 }
 if(phase==='publish'){
  const prepared=current();if(prepared?.id!==job.id||prepared.submitted||prepared.signature!==formSignature()||!prepared.photoZone?.isConnected||prepared.photos!==imageSignature(prepared.photoZone)||prepared.title.value!==payload.title||prepared.description.value!==payload.description||Number(prepared.price.value)!==payload.price)throw Error('出品直前の内容を確認できません');
  const forms=[...root.querySelectorAll('form')].filter(visible);if(forms.some(form=>!form.checkValidity()))throw Error('出品に必要な項目が不足しています');
  const confirm=controls().filter(e=>['確認画面へ','確認する','出品内容を確認する'].includes(buttonLabel(e)));
  if(confirm.length===1){confirm[0].click();return {confirmation:true};}
  if(job.channel==='ヤフオク'&&!prepared.auctionOptionsConfirmed)throw Error('自動延長・再出品の設定を確認できません。出品は送信しません');
  const button=oneButton(['出品する','出品']);reserve();button.click();return {submitted:true};
 }
 if(phase==='publish_confirmation'){
  if(!/確認|出品/.test(text()))throw Error('出品の確認画面ではありません');
  const frames=[...root.querySelectorAll('iframe')].flatMap(frame=>{try{return [frame.contentDocument?.body?.innerText||''];}catch{return [];}}).join(' ');
  const normalized=choiceText(text()+' '+frames).replaceAll(',','');for(const value of expectedValues()){if(!normalized.includes(choiceText(value).replaceAll(',','')))throw Error('確認画面で出品内容が一致しません');}
  if(job.channel==='ヤフオク'&&(!['あり','する','有効'].includes(confirmationSetting('自動延長'))||!['なし','しない','0回','設定しない'].includes(confirmationSetting('自動再出品'))))throw Error('確認画面で自動延長あり・自動再出品なしを確認できません。出品は送信しません');
  const button=oneButton(['出品する','ガイドラインに同意して出品する']);reserve();button.click();return {submitted:true};
 }
 if(phase==='listing_result'){
  return waitFor(()=>{
   const direct=job.channel==='メルカリ'?location.href.match(/^https:\/\/jp[.]mercari[.]com\/item\/(m[0-9]+)/):location.href.match(/^https:\/\/page[.]auctions[.]yahoo[.]co[.]jp\/jp\/auction\/([a-z][0-9]+)/i);
   let id=direct?.[1];if(!id&&/出品が完了|出品しました|出品完了/.test(text())){const links=[...root.querySelectorAll('a[href]')].map(a=>a.href.match(job.channel==='メルカリ'?/^https:\/\/jp[.]mercari[.]com\/item\/(m[0-9]+)/:/^https:\/\/page[.]auctions[.]yahoo[.]co[.]jp\/jp\/auction\/([a-z][0-9]+)/i)).filter(Boolean);const ids=new Set(links.map(value=>value[1]));if(ids.size===1)id=[...ids][0];}
   if(!id||!text().includes(norm(payload.title)))return null;return {external_id:id,url:job.channel==='メルカリ'?'https://jp.mercari.com/item/'+id:'https://page.auctions.yahoo.co.jp/jp/auction/'+id};
  },'出品結果を確認できません。サイトで確認するまで再実行しません');
 }
 tradeGuard();
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
  await choose(['サイズ','配送サイズ'],payload.size);await choose(['発送場所','発送する場所'],payload.dropoff);await choose(['品名','商品名'],payload.category);
  const button=oneButton(['配送用の2次元コードを表示する','配送用QRコードを表示','2次元コードを発行する','QRコードを表示']);reserve();button.click();
  const code=await waitFor(()=>{const canvases=[...root.querySelectorAll('canvas')].filter(canvas=>visible(canvas)&&/QR|2次元|二次元/.test(canvas.getAttribute('aria-label')||canvas.id||''));const images=[...root.querySelectorAll('img')].filter(image=>visible(image)&&/QR|2次元|二次元|配送コード/.test(image.alt));if(canvases.length===1)return canvases[0].toDataURL('image/png');if(images.length===1&&images[0].src.startsWith('data:image/png;base64,'))return images[0].src;return null;},'配送コードの発行結果を確認できません');return {qr_code:code};
 }
 if(phase==='register_package'){
  if(!/ゆうパケットポスト/.test(text()))throw Error('専用資材を使用する発送画面ではありません');
  const input=field(['発送用コード','2次元コード','専用資材コード','ポスト発送確認用番号']);setValue(input,payload.code);const button=oneButton(['登録する','コードを登録','読み取り内容を登録']);reserve();button.click();await waitFor(()=>statusValues().some(value=>/^(登録完了|読み取り完了|登録が完了しました|読み取りが完了しました)$/.test(value)),'専用資材の登録結果を確認できません');return {registered:true,note:'専用資材を対象取引へ登録しました'};
 }
 if(phase==='ship_notice'){
  const button=oneButton(['発送したことを通知する','商品の発送を通知する','発送通知をする','発送通知','商品を発送したので発送連絡する']);reserve();button.click();await waitFor(()=>statusValues().some(value=>/^(発送通知をしました|発送通知が完了しました|商品の発送を通知しました|発送済み|配送中)$/.test(value))&&(!button.isConnected||button.disabled),'発送通知の結果を確認できません。再送しません');return {notified:true,note:'発送通知を送信しました'};
 }
 throw Error('未対応の販売サイト操作です');
}
