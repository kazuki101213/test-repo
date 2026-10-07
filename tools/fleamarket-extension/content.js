(() => {
  if(globalThis.__fleamarketSupport) return;
  globalThis.__fleamarketSupport=true;
  const norm=s=>(s||'').replace(/\s+/g,' ').trim();
  const visible=e=>!!e&&e.getClientRects().length>0&&getComputedStyle(e).visibility!=='hidden';
  function messageHash(value){let h=14695981039346656037n;for(const char of value){h^=BigInt(char.codePointAt(0));h=BigInt.asUintN(64,h*1099511628211n);}return h.toString(16).padStart(16,'0');}
  const one=(selector,root=document)=>{const rows=[...root.querySelectorAll(selector)].filter(visible);if(rows.length!==1) throw new Error('対象要素が1件に限定できません: '+selector);return rows[0];};
  function authProblem(){
    if(document.querySelector('input[autocomplete="one-time-code"]')) return '追加承認待ち';
    if(document.querySelector('input[type="password"]')||/\/login|\/signin|\/auth\//.test(location.pathname)) return 'ログイン切れ';
    const text=norm(document.querySelector('main')?.innerText||document.body.innerText);
    if(/認証コードを入力|本人確認が必要|追加認証|ロボットではない|セキュリティチェック/.test(text)) return '追加承認待ち';
    return null;
  }
  function identity(a){
    if(a.identity?.pageUrl){
      safeUrl(a.site,a.identity.pageUrl);if(!['rakuma','mercari','flea','auctions'].includes(a.site))throw new Error('アカウント確認ページが不正です');
      if(location.href!==a.identity.pageUrl){
        if(a._identityConfirmed!==true)throw new Error('登録したページでアカウント確認が必要です');
        return;
      }
    }
    if(a.site==='mercari'&&a.identity?.selector?.includes('header')&&a.identity.selector.endsWith(' > p')){
      const names=[...document.querySelectorAll('header button p')].filter(e=>visible(e)&&norm(e.innerText)===a.identity.text);
      if(names.length!==1){const shown=[...document.querySelectorAll('header button p')].filter(visible).map(e=>norm(e.innerText)).filter(Boolean);throw new Error(shown.length===1&&shown[0]!==a.identity.text?'名前不一致: 登録名とログイン名が異なります':'画面確認待ち: 本人名の表示を1件に確認できません');}return;
    }
    if(a.site==='auctions'&&location.origin==='https://auctions.yahoo.co.jp'&&location.pathname==='/my/won'){
      const names=[...document.querySelectorAll('header p > a')].filter(e=>visible(e)&&norm(e.innerText)===a.identity.text);
      if(names.length!==1)throw new Error('ログイン中のアカウント名を1件に確認できません');return;
    }
    const e=one(a.identity.selector);
    if(norm(e.innerText||e.getAttribute('aria-label'))!==a.identity.text) throw new Error('ログイン中のアカウントが登録内容と一致しません');
  }
  function safeUrl(site,url){
    const hosts={mercari:['jp.mercari.com'],auctions:['auctions.yahoo.co.jp','page.auctions.yahoo.co.jp','contact.auctions.yahoo.co.jp','buy.auctions.yahoo.co.jp'],flea:['paypayfleamarket.yahoo.co.jp','paypayfleamarket-sec.yahoo.co.jp'],rakuma:['fril.jp','www.fril.jp','item.fril.jp','web.fril.jp']};
    const u=new URL(url,location.href);if(u.protocol!=='https:'||!hosts[site]?.includes(u.hostname)) throw new Error('登録サイト以外のURLです');return u.href;
  }
  function getId(site,url){
    const u=new URL(url,location.href);
    if(site==='mercari') return u.pathname.match(/\/(?:item|transaction)\/(m\d+)(?:\/|$)/)?.[1];
    if(site==='auctions') return u.pathname.match(/\/auction\/([a-zA-Z]\d+)(?:\/|$)/)?.[1]||['aID','aid','auctionID'].map(k=>u.searchParams.get(k)).find(v=>/^[a-zA-Z]\d+$/.test(v||''));
    if(site==='flea') return u.pathname.match(/\/(?:item|transaction)\/([a-zA-Z]\d+)(?:\/|$)/)?.[1];
    if(site==='rakuma') return u.pathname.match(/^\/([a-f0-9]{32})(?:\/|$)/)?.[1]||u.pathname.match(/\/(?:item|transaction|trade|deal)\/([a-f0-9]{32})(?:\/|$)/)?.[1] || (u.pathname==='/transaction'&&/^[a-f0-9]{32}$/.test(u.searchParams.get('item_id')||'')?u.searchParams.get('item_id'):null);
  }
  function controlText(e){return norm(e.innerText||e.value||e.getAttribute('aria-label'));}
  const RECEIPT=/^(受取評価をする|受け取り評価をする|受け取り連絡をする|受取通知をする|商品の受け取り|商品を受け取りました|受け取り評価)$/;
  function detail(a,recipe){
    const problem=authProblem(); if(problem) return {auth:problem};
    identity(a);const scope=one(recipe.scope||'main');const text=norm(scope.innerText);
    const buttons=[...scope.querySelectorAll('button,a,input[type="submit"],label')].filter(visible).map(controlText);
    const completed=/取引が完了しました|取引は完了しました|取引完了済み|受取評価済み|受け取り連絡済み|受取通知済み/.test(text);
    const seller=buttons.some(t=>/^(発送通知をする|発送したので、発送通知をする|購入者を評価する|発送連絡をする)$/.test(t));
    const buyerInformation=a.site==='mercari'&&[...scope.querySelectorAll('[data-testid="transaction:information-for-buyer"]')].filter(visible).length===1;
    const receiptForms=[...scope.querySelectorAll('form')].filter(form=>[...form.querySelectorAll('input[type="checkbox"][data-testid="transaction:evaluation-item-received"]')].filter(visible).length===1&&[...form.querySelectorAll('button[type="submit"]')].filter(e=>visible(e)&&controlText(e)==='評価を投稿する').length===1);
    const mercariEvaluation=buyerInformation&&receiptForms.length===1;
    const buyer=!seller&&(mercariEvaluation||buttons.some(t=>RECEIPT.test(t))||/出品者からの発送をお待ちください|発送をお待ちください|受取評価をしてください|商品が到着したら.*評価|商品が届いたら.*受け取り/.test(text));
    let id=getId(a.site,location.href);
    const ids=new Set([...scope.querySelectorAll('a[href]')].map(e=>{try{return getId(a.site,safeUrl(a.site,e.href));}catch{return null;}}).filter(Boolean));
    if(!id&&ids.size===1) id=[...ids][0];
    if(!id||ids.size>1||(ids.size===1&&!ids.has(id))) throw new Error('取引の商品IDを1件に確定できません');
    const nums=new Set();
    for(const m of text.matchAll(/(?:追跡番号|お問い合わせ番号|お問合せ番号|送り状番号|伝票番号)[：:\s]*([0-9][0-9\s\-－]{6,26}[0-9])/g)) {
      const n=m[1].replace(/[\s\-－]/g,'');if(/^\d{8,20}$/.test(n)) nums.add(n);
    }
    return {itemId:id,role:seller?'seller':buyer?'buyer':'unknown',state:completed?'completed':buyer?'pending':'unknown',trackingNo:nums.size===1?[...nums][0]:null,trackingAmbiguous:nums.size>1,receiptControls:buttons.filter(t=>RECEIPT.test(t))};
  }
  function conversation(a,recipe){
    const d=detail(a,recipe);if(d.auth)return d;
    const root=one(recipe.messageScope||'main');
    const marked=[...root.querySelectorAll('[data-testid*="message" i],[class*="message" i],[aria-label*="メッセージ"]')].filter(visible);
    const nodes=marked.filter(e=>{
      const text=norm(e.innerText);
      return text.length>0&&text.length<=10000&&!e.matches('textarea,input,button,[contenteditable="true"]')
        && ![...e.querySelectorAll('[data-testid*="message" i],[class*="message" i]')].some(child=>visible(child)&&norm(child.innerText).length>10);
    });
    const messages=[];const seen=new Set();
    for(const [index,e] of nodes.entries()){
      const body=norm([...e.querySelectorAll('p,[data-testid*="body" i],[class*="body" i]')].filter(visible).map(x=>x.innerText).join('\n')||e.innerText);
      if(!body||body.length>10000)continue;
      const authorNode=e.querySelector('[data-testid*="author" i],[class*="author" i],[aria-label*="さん"]');
      const author=norm(authorNode?.getAttribute('aria-label')||authorNode?.innerText||e.getAttribute('data-author')||'').slice(0,200)||null;
      const ownName=(a.identity?.text||'').replace(/さんのマイページ$/,'');
      const own=author===ownName||!!author&&!!ownName&&author.includes(ownName);
      const time=e.querySelector('time[datetime]');
      const timeText=norm(time?.getAttribute('datetime')||'');
      const signature=[author||'',timeText,body].join('|');
      if(seen.has(signature))continue;seen.add(signature);
      const instant=timeText&&Number.isFinite(Date.parse(timeText))?new Date(timeText).toISOString():null;
      const externalId=messageHash([a.site,d.itemId,author||'',timeText,body,index].join('|'));
      messages.push({external_id:externalId,author,author_role:own?'self':author?'other':'unknown',body,sent_at:instant});
      if(messages.length>=500)break;
    }
    return {...d,messages};
  }
  function messageComposer(a,recipe,expected){
    const d=detail(a,recipe);
    if(d.auth||d.itemId!==expected)throw new Error('送信する取引IDが一致しません');
    const root=one(recipe.messageScope||'main');
    const forms=[...root.querySelectorAll('form')].filter(visible).map(form=>({form,fields:[...form.querySelectorAll('textarea,[contenteditable="true"]')].filter(visible),buttons:[...form.querySelectorAll('button,input[type="submit"]')].filter(visible)})).filter(x=>x.fields.length===1&&x.buttons.length===1);
    if(forms.length!==1)throw new Error('取引メッセージの入力欄と送信ボタンを一組に特定できません');
    const {form,fields:[field],buttons:[button]}=forms[0];
    const label=norm(field.getAttribute('aria-label')||field.getAttribute('placeholder')||field.getAttribute('data-placeholder'));
    const buttonLabel=controlText(button);
    if(!/メッセージ|取引連絡|コメント/.test(label+' '+buttonLabel)||!/送信|送る|投稿/.test(buttonLabel))throw new Error('取引メッセージ用の送信フォームと確認できません');
    if(field.disabled||button.disabled||!visible(form))throw new Error('取引メッセージのフォームが利用できません');
    return {field,button,form};
  }
  function setMessageValue(field,value){
    if(field.isContentEditable){field.textContent=value;field.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:value}));return;}
    setValue(field,value);
  }
  async function sendMarketplaceMessage(a,recipe,expected,body){
    if(typeof body!=='string'||!body.trim()||body.length>2000)throw new Error('メッセージは1〜2000文字で入力してください');
    identity(a);const {field,button}=messageComposer(a,recipe,expected);
    if(field.isContentEditable?norm(field.innerText):field.value)throw new Error('入力欄に既存の文章があるため送信を中止しました');
    setMessageValue(field,body.trim());
    if(norm(field.isContentEditable?field.innerText:field.value)!==body.trim())throw new Error('送信文を入力欄で確認できません');
    if(!visible(button)||button.disabled)throw new Error('送信ボタンが利用できません');
    identity(a);if(getId(a.site,location.href)!==expected)throw new Error('送信直前に取引画面が変わりました');
    button.click();return {clicked:true,itemId:expected};
  }

  function purchaseDate(row,site,referenceDay){
    const stamp=row.querySelector('time[datetime]')?.getAttribute('datetime');
    const leaf=[...row.querySelectorAll('*')].filter(e=>visible(e)&&!e.children.length).map(e=>norm(e.innerText));
    const full=stamp?.match(/^(\d{4})-(\d{2})-(\d{2})/)||leaf.map(t=>t.match(/^(?:購入日|購入日時|落札日|落札日時|取引日)[：:\s]*(\d{4})[年./-](\d{1,2})[月./-](\d{1,2})日?/)
      ||t.match(/^(\d{4})[年./-](\d{1,2})[月./-](\d{1,2})日?\s+\d{1,2}:\d{2}$/)).find(Boolean);
    if(full){const value=full[1]+'-'+full[2].padStart(2,'0')+'-'+full[3].padStart(2,'0');const d=new Date(value+'T00:00:00Z');return Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===value?value:null;}
    if(site==='auctions'){
      const dates=[...new Set(leaf.filter(t=>/^\d{1,2}\/\d{1,2}\s+\d{1,2}:\d{2}$/.test(t)))];
      if(dates.length!==1)return null;const m=dates[0].match(/^(\d{1,2})\/(\d{1,2})/),suffix=m[1].padStart(2,'0')+'-'+m[2].padStart(2,'0');let year=Number(referenceDay.slice(0,4));if(suffix>referenceDay.slice(5))year--;
      const value=year+'-'+suffix,d=new Date(value+'T00:00:00Z');return Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===value?value:null;
    }return null;
  }
  function purchaseMoney(root,site){
    const values=new Set();const money=t=>{const m=t.match(/^(?:¥|￥)?\s*([0-9][0-9,]*)\s*(?:円)?(?:\s*\(税込\))?$/);if(m){const v=Number(m[1].replace(/,/g,''));if(Number.isSafeInteger(v)&&v>=0&&v<1e10)values.add(v);}};
    for(const e of [...root.querySelectorAll('*')].filter(e=>visible(e)&&!e.children.length)){
      const t=norm(e.innerText),label=t.match(/^(?:購入金額|購入価格|落札価格|落札金額|商品代金|商品価格)[：:\s]*(.*)$/);
      if(label){if(label[1])money(label[1]);else money(norm(e.nextElementSibling?.innerText||e.parentElement?.nextElementSibling?.innerText));}
      // A dedicated price cell in a won/purchased row is the transaction price, never a title amount.
      if(site==='auctions'&&/^(?:¥|￥)?\s*[0-9][0-9,]*\s*円(?:\s*\(税込\))?$/.test(t))money(t);
    }
    for(const e of [...root.querySelectorAll('*')].filter(visible)){const label=norm(e.innerText).match(/^(?:購入金額|購入価格|落札価格|落札金額|商品代金|商品価格)[：:\s]*(.*)$/);if(label?.[1])money(label[1]);}if(site==='auctions')for(const e of [...root.querySelectorAll('*')].filter(visible)){const t=norm(e.innerText);if(/^(?:¥|￥)?\s*[0-9][0-9,]*\s*円(?:\s*\(税込\))?$/.test(t))money(t);}
    return values.size===1?[...values][0]:null;
  }
  function purchaseContainer(a,e,scope){
    let row=e;for(let parent=e.parentElement,depth=0;parent&&parent!==scope&&scope.contains(parent)&&depth<6;parent=parent.parentElement,depth++){
      const ids=new Set([...parent.querySelectorAll('a[href]')].map(x=>{try{return getId(a.site,safeUrl(a.site,x.href));}catch{return null;}}).filter(Boolean));
      if(ids.size!==1)break;row=parent;
    }return row;
  }
  function purchaseRow(a,row,id,url,referenceDay){
    const text=norm(row.innerText);const transactionLinks=[...(row.matches('a[href]')?[row]:[]),...row.querySelectorAll('a[href]')].filter(e=>{try{return getId(a.site,safeUrl(a.site,e.href))===id&&/transaction|trade|deal|contact\.auctions|buy\.auctions/.test(e.href);}catch{return false;}});
    if(a.site==='auctions'&&!text.includes('商品ID')&&!transactionLinks.length)return null;
    if(a.site==='mercari'&&!purchaseDate(row,a.site,referenceDay)&&!row.closest('[data-testid="purchase-item-list"]'))return null;
    if(['flea','rakuma'].includes(a.site)&&!transactionLinks.length&&!purchaseDate(row,a.site,referenceDay))return null;
    const ownLinks=[...(row.matches('a[href]')?[row]:[]),...row.querySelectorAll('a[href]')].filter(e=>{try{return getId(a.site,safeUrl(a.site,e.href))===id;}catch{return false;}});
    const titleNodes=[...row.querySelectorAll('[data-testid*="title" i],[class*="title" i],h3,h4')].filter(visible);
    const titleCandidates=[...titleNodes.map(e=>norm(e.innerText)),...ownLinks.map(e=>norm(e.getAttribute('title')||e.getAttribute('aria-label')||e.innerText)),...row.querySelectorAll('img[alt]')].map(v=>typeof v==='string'?v:norm(v.alt)).filter(t=>t&&!/^(取引連絡|取引画面|評価|詳細を見る|商品ページへ|商品画像|サムネイル|発送待ち|取引完了)$/.test(t));
    const leafTitles=[...row.querySelectorAll('p,span')].filter(e=>visible(e)&&!e.children.length).map(e=>norm(e.innerText)).filter(t=>t.length>12&&!/^\d{4}[./-]\d/.test(t)&&!/^(商品ID|取引|落札日|購入日|発送|支払い)/.test(t)&&!/^\d[\d,]*\s*円$/.test(t));
    const title=(titleNodes.length?norm(titleNodes[0].innerText):(['mercari','flea'].includes(a.site)?[...row.querySelectorAll('p')].filter(e=>visible(e)&&!e.children.length).map(e=>norm(e.innerText)).find(t=>t&&!/^\d{4}[年./-]/.test(t)&&!/^(取引|購入日|落札日|発送|支払い)/.test(t)):null)||titleCandidates[0])?.replace(/\s+\d{4}[./-]\d{1,2}[./-]\d{1,2}\s+\d{1,2}:\d{2}.*$/,'').slice(0,500)||null;
    const canonical={mercari:'https://jp.mercari.com/item/',auctions:'https://auctions.yahoo.co.jp/jp/auction/',flea:'https://paypayfleamarket.yahoo.co.jp/item/',rakuma:'https://item.fril.jp/'}[a.site]+id;
    const detailUrl=transactionLinks[0]?.href||(a.site==='mercari'?'https://jp.mercari.com/transaction/'+id:url);
    return {marketplace_item_id:id,marketplace_url:canonical,detailUrl,title,purchased_at:purchaseDate(row,a.site,referenceDay),cost_amount:purchaseMoney(row,a.site),cancelled:/取引がキャンセルされました|キャンセル済み|取引キャンセル|購入をキャンセル/.test(text)};
  }
  async function parsePurchaseDetail(a,recipe,expected){
    const auth=authProblem();if(auth)return {auth};identity(a);
    let pageId=getId(a.site,location.href);if(a.site==='rakuma'&&location.hostname==='web.fril.jp'&&location.pathname==='/v2/purchase/item'&&[...new URL(location.href).searchParams.values()].includes(expected))pageId=expected;safeUrl(a.site,location.href);if(a.site==='rakuma'&&location.hostname==='web.fril.jp'&&!pageId){const ids=new Set([...document.querySelectorAll('a[href]')].map(x=>{try{return getId(a.site,safeUrl(a.site,x.href));}catch{return null;}}).filter(Boolean));if(ids.size===1&&ids.has(expected))pageId=expected;}if(pageId!==expected)throw new Error('購入詳細の商品IDが一致しません: '+location.hostname+location.pathname);const mains=[...document.querySelectorAll('main')].filter(visible);if(mains.length>1)throw new Error('購入詳細の表示領域が複数あります');const root=mains[0]||document.body;
    const text=norm(root.innerText);if([...root.querySelectorAll('button')].filter(visible).some(e=>/^(発送通知をする|購入者を評価する|発送連絡をする)$/.test(controlText(e))))throw new Error('出品者側の画面のため取得しません');
    const dateLabels=[...text.matchAll(/(?:購入日時|購入日|落札日時|落札日)[：:\s]*(\d{4})[年./-](\d{1,2})[月./-](\d{1,2})日?/g)];
    const dates=[...new Set(dateLabels.map(m=>m[1]+'-'+m[2].padStart(2,'0')+'-'+m[3].padStart(2,'0')))];
    return {purchased_at:dates.length===1?dates[0]:null,cost_amount:purchaseMoney(root,'detail'),title:null,cancelled:/取引がキャンセルされました|キャンセル済み/.test(text)};
  }
  async function purchaseDetail(a,recipe,expected){
    const limit=Number.isFinite(recipe.detailWaitMs)?Math.max(0,Math.min(recipe.detailWaitMs,18000)):18000,until=Date.now()+limit;let result;
    do{try{result=await parsePurchaseDetail(a,recipe,expected);if(result.auth||result.cancelled||result.cost_amount!==null||result.purchased_at!==null||Date.now()>=until)return result;}catch(e){if(!/購入詳細の商品IDが一致しません/.test(e.message)||Date.now()>=until)throw e;}await new Promise(r=>setTimeout(r,350));}while(true);
  }
  async function purchaseMore(a,recipe,seenIds){
    const auth=authProblem();if(auth)return {auth};identity(a);
    if(location.origin+location.pathname!==new URL(a.listUrl).origin+new URL(a.listUrl).pathname)throw new Error('購入一覧以外で続きを操作できません');
    if(a.site==='rakuma')await readList(a,{...recipe,listWaitMs:8000});const root=a.site==='rakuma'?(document.querySelector('main')||document.body):one('main');const before=new Set(seenIds);let previousCount=-1,stable=0;
    for(let i=0;i<20;i++){
      const data=list(a,recipe);const rows=data.purchaseRows||[];
      if(rows.some(r=>!before.has(r.marketplace_item_id)))return {more:true};
      const controls=[...root.querySelectorAll('button,a')].filter(e=>visible(e)&&/^(もっと見る|さらに表示|次のページ|次へ)$/.test(controlText(e)));
      if(controls.length>1)return {endConfirmed:false};
      const loading=[...root.querySelectorAll('[aria-busy="true"],[role="progressbar"],[data-testid*="skeleton"]')].some(visible);
      if(controls.length===1&&!controls[0].disabled){identity(a);controls[0].click();stable=0;}
      else {root.scrollIntoView({block:'end'});window.scrollTo(0,document.documentElement.scrollHeight);stable=rows.length===previousCount&&!loading?stable+1:0;if(stable>=2)return {endConfirmed:!loading};}
      previousCount=rows.length;await new Promise(r=>setTimeout(r,1500));
    }return {endConfirmed:false};
  }

  function list(a,recipe){
    const problem=authProblem();if(problem)return {auth:problem};identity(a);
    let scope;
    if(recipe.listScope)scope=one(recipe.listScope);
    else if(a.site==='rakuma'&&location.pathname==='/buy'){
      const headings=[...document.querySelectorAll('h2')].filter(e=>visible(e)&&norm(e.innerText)==='購入した商品');
      if(headings.length!==1)throw new Error('ラクマの購入一覧を1件に限定できません');
      scope=headings[0].parentElement;const headingScope=scope;
      for(let depth=0;depth<6&&scope&&scope!==document.body;depth++,scope=scope.parentElement){
        if([...scope.querySelectorAll('a[href]')].some(e=>{try{return new URL(safeUrl('rakuma',e.href)).pathname==='/transaction'&&!!getId('rakuma',e.href);}catch{return false;}}))break;
      }
      if(!scope||scope===document.body)scope=headingScope;
    }else scope=one('main');
    const text=norm(scope.innerText);
    if(!/購入した商品|購入履歴|購入した取引|落札した商品|落札分/.test(text)) throw new Error('購入者側の取引一覧を確認できません');
    if(recipe.listHeading&&!text.includes(recipe.listHeading)) throw new Error('登録した購入一覧の見出しが見つかりません');
    const links=[];const purchases=[];const purchaseRows=new Map();const inventoryRows=new Map();let completedCount=0;
    for(const e of scope.querySelectorAll(recipe.transactionLinks||'a[href]')){
      if(!visible(e))continue;let url;try{url=safeUrl(a.site,e.href);}catch{continue;}
      const u=new URL(url);const isTransaction=/transaction|trade|deal|contact\.auctions\.yahoo\.co\.jp|buy\.auctions\.yahoo\.co\.jp/.test(u.pathname+' '+u.hostname);
      const id=getId(a.site,url);if(!id)continue;
      const row=recipe.purchaseImport&&['flea','rakuma'].includes(a.site)?purchaseContainer(a,e,scope):e.closest('li,tr,article,[data-testid="transaction"],[data-testid*="item" i]')||e.parentElement;
      const rowIds=new Set([...row.querySelectorAll('a[href]')].map(link=>{try{return getId(a.site,safeUrl(a.site,link.href));}catch{return null;}}).filter(Boolean));if(row===e)rowIds.add(id);

      if(recipe.purchaseImport&&rowIds.size===1&&rowIds.has(id)){const r=purchaseRow(a,row,id,url,recipe.referenceDay||new Date(Date.now()+9*3600000).toISOString().slice(0,10));if(r&&!purchaseRows.has(id))purchaseRows.set(id,r);}
      if(recipe.inventoryFirst&&rowIds.size===1&&rowIds.has(id)){
        const dates=[...norm(row.innerText).matchAll(/(\d{4})[年./-](\d{1,2})[月./-](\d{1,2})日?/g)];
        const stamp=row.querySelector('time[datetime]')?.getAttribute('datetime');
        const dateParts=stamp?.match(/^(\d{4})-(\d{2})-(\d{2})/)||(a.site!=='auctions'&&dates.length===1?dates[0]:null);
        let purchasedAt=dateParts?dateParts[1]+'-'+dateParts[2].padStart(2,'0')+'-'+dateParts[3].padStart(2,'0'):null;
        if(a.site==='auctions'&&!purchasedAt){const current=recipe.referenceDay||new Date(Date.now()+9*3600000).toISOString().slice(0,10);const dateTexts=[...new Set([...row.querySelectorAll('*')].filter(visible).map(x=>norm(x.innerText)).filter(t=>/^\d{1,2}\/\d{1,2}\s+\d{1,2}:\d{2}$/.test(t)))];if(dateTexts.length===1){const parts=dateTexts[0].match(/^(\d{1,2})\/(\d{1,2})/);const suffix=parts[1].padStart(2,'0')+'-'+parts[2].padStart(2,'0');let year=Number(current.slice(0,4));if(suffix>current.slice(5))year--;const value=year+'-'+suffix;const parsed=new Date(value+'T00:00:00Z');if(Number.isFinite(parsed.getTime())&&parsed.toISOString().slice(0,10)===value)purchasedAt=value;}}

        let detailUrl=url;
        if(a.site==='mercari'&&u.pathname.startsWith('/item/'))detailUrl='https://jp.mercari.com/transaction/'+id;
        const previous=inventoryRows.get(id);
        if(!previous||isTransaction)inventoryRows.set(id,{itemId:id,url:detailUrl,purchasedAt:purchasedAt||previous?.purchasedAt||null});
      }
      if(!recipe.includeCompleted&&rowIds.size===1&&rowIds.has(id)&&/取引完了|評価済み|受け取り連絡済み/.test(norm(row.innerText))){if(isTransaction)completedCount++;continue;}
      if(isTransaction)links.push(url);
      if(row){
        const rowText=norm(row.innerText).slice(0,3000);
        const titleNode=row.querySelector('[data-testid*="title" i],[class*="title" i],h1,h2,h3,h4');
        const title=norm(titleNode?.innerText||e.getAttribute('aria-label')||e.innerText).replace(/^(取引画面|取引詳細|詳細を見る|商品ページへ)\s*/, '').slice(0,500);
        const priceNode=row.querySelector('[data-testid*="price" i],[class*="price" i],[aria-label*="円"]');
        const priceText=norm(priceNode?.getAttribute('aria-label')||priceNode?.innerText||'');
        const priceMatch=(priceText||rowText).match(/(?:¥|￥)\s*([0-9][0-9,]{0,9})|\b([0-9][0-9,]{0,9})\s*円/);
        const dateNode=row.querySelector('time[datetime]');
        const dateValue=dateNode?.getAttribute('datetime')||rowText.match(/(?:購入日|落札日|取引日|支払日)[：:\s]*(\d{4}[年./-]\d{1,2}[月./-]\d{1,2}日?)/)?.[1]||'';
        const dateMatch=dateValue.match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
        const purchasedAt=dateMatch?`${dateMatch[1]}-${dateMatch[2].padStart(2,'0')}-${dateMatch[3].padStart(2,'0')}`:null;
        const productUrl=a.site==='auctions'?`https://auctions.yahoo.co.jp/jp/auction/${id}`:url;
        if(id&&title) purchases.push({marketplace_item_id:id,marketplace_url:productUrl,title,purchased_at:purchasedAt,cost_amount:priceMatch?Number((priceMatch[1]||priceMatch[2]).replace(/,/g,'')):null});
      }
    }
    const next=[...scope.querySelectorAll('a[href]')].find(e=>visible(e)&&/^(次へ|次のページ|次›|›)$/.test(controlText(e)));
    let nextUrl=null;if(next){try{const u=new URL(safeUrl(a.site,next.href));if(u.origin===location.origin&&u.pathname===location.pathname)nextUrl=u.href;}catch{}}
    const continuationUnconfirmed=!nextUrl&&[...scope.querySelectorAll('button,a')].some(e=>visible(e)&&/もっと見る|さらに表示|次のページ|次へ/.test(controlText(e)));
    return {links:[...new Set(links)],purchases,...(recipe.purchaseImport?{purchaseRows:[...purchaseRows.values()]}:{}),nextUrl,completedCount,continuationUnconfirmed,...(recipe.inventoryFirst?{inventoryRows:[...inventoryRows.values()]}:{})};
  }
  async function readList(a,recipe){
    const limit=Number.isFinite(recipe.listWaitMs)?Math.max(0,Math.min(recipe.listWaitMs,recipe.purchaseImport?18000:8000)):(recipe.purchaseImport?18000:8000);
    let until=Date.now()+limit;let result;let filterApplied=false;let purchasedTabApplied=false;
    do{
      const auth=authProblem();if(auth)return {auth};
      if(a.site==='rakuma'&&recipe.purchaseImport&&!purchasedTabApplied){identity(a);const tabs=[...document.querySelectorAll('a,button')].filter(e=>visible(e)&&controlText(e)==='購入済');if(tabs.length!==1)throw new Error('ラクマの購入済一覧を1件に確認できません');tabs[0].click();purchasedTabApplied=true;until=Date.now()+limit;await new Promise(r=>setTimeout(r,500));continue;}if(a.site==='mercari'&&(!recipe.includeCompleted||recipe.purchaseImport)&&!filterApplied){
        const filter=document.querySelector('[data-testid="user-listing-inTransactionItemsCheckbox"]');
        const box=filter?.matches('input[type="checkbox"]')?filter:filter?.querySelector('input[type="checkbox"]');
        if(box&&visible(box)&&!box.disabled&&(recipe.purchaseImport?box.checked:!box.checked)){identity(a);box.click();filterApplied=true;until=Date.now()+limit;await new Promise(resolve=>setTimeout(resolve,350));continue;}
      }
      if(a.site==='mercari'&&document.querySelector('[data-testid="items-skeleton"]')&&Date.now()<until){await new Promise(resolve=>setTimeout(resolve,350));continue;}
      result=list(a,recipe);if(result.auth||(recipe.purchaseImport?result.purchaseRows?.length:result.links.length||result.purchases?.length||result.inventoryRows?.length))return result;
      const text=norm((document.querySelector('main')||document.body).innerText);
      if(result.completedCount>0||(recipe.purchaseImport?/購入済みの商品[はが]ありません|購入済の商品[はが]ありません|購入した商品[はが]ありません|購入履歴[はが]ありません/:/購入した商品[はが]ありません|購入履歴[はが]ありません|取引中の商品[はが]ありません/).test(text))return {...result,emptyConfirmed:true};
      if(Date.now()>=until)break;await new Promise(resolve=>setTimeout(resolve,350));
    }while(true);
    return {...result,incomplete:true};
  }
  async function readDetail(a,r){
    const limit=Number.isFinite(r.detailWaitMs)?Math.max(0,Math.min(r.detailWaitMs,8000)):8000;
    const until=Date.now()+limit;let d;
    do{d=detail(a,r);if(d.auth||d.state==='completed'||d.role==='seller'||(d.role==='buyer'&&(d.trackingNo||d.trackingAmbiguous)))return d;
      if(Date.now()>=until)return d;await new Promise(resolve=>setTimeout(resolve,350));
    }while(true);
  }
  function recipeField(root,selector){if(!selector)return null;return one(selector,root);}
  function receiptPreflight(a,r,expected){
    if(!r.receiptVerified) throw new Error('評価画面の実地検証が未完了です');
    const d=detail(a,r);if(d.auth||d.role!=='buyer'||d.state!=='pending'||d.itemId!==expected)throw new Error('評価直前の取引条件が一致しません');
    const root=one(r.receiptScope);
    const positive=recipeField(root,r.positive),submit=recipeField(root,r.submit),comment=recipeField(root,r.comment);
    if(!positive||!submit||controlText(submit)!==r.submitText||!RECEIPT.test(r.submitText))throw new Error('検証済み評価ボタンと一致しません');
    const statefulButton=positive.tagName==='BUTTON'&&(positive.hasAttribute('aria-pressed')||(positive.getAttribute('role')==='radio'&&positive.hasAttribute('aria-checked')));
    if(!(positive.type==='radio'||statefulButton)||positive.disabled||submit.disabled)throw new Error('良い評価の選択要素を確認できません');
    const label=positive.labels?.[0]?.innerText||positive.getAttribute('aria-label')||positive.innerText;
    if(!/^(良かった|よい|良い|非常に良い)$/.test(norm(label))) throw new Error('良い評価のラベルを確認できません');
    const confirm=recipeField(root,r.confirm);
    if(confirm&&(!/^商品を受け取りました$/.test(norm(confirm.labels?.[0]?.innerText||confirm.getAttribute('aria-label')))||confirm.type!=='checkbox'))throw new Error('受け取り確認の要素が一致しません');
    if(comment&&comment.tagName!=='TEXTAREA')throw new Error('評価コメント欄が一致しません');
    if(comment?.value) throw new Error('入力済みの評価コメントがあるため停止しました');
    const fields=[...root.querySelectorAll('input,textarea,select')].filter(e=>visible(e)&&!e.disabled&&e.required);
    if(fields.some(e=>e!==positive&&e!==comment&&e!==confirm&&!e.checkValidity()))throw new Error('未知の必須入力があるため停止しました');
    return {positive,submit,comment,confirm};
  }
  function setValue(e,value){const proto=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(e,value);e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));}
  async function submitReceipt(a,r,expected){
    const {positive,submit,comment,confirm}=receiptPreflight(a,r,expected);
    if(!positive.checked)positive.click();if(confirm&&!confirm.checked)confirm.click();
    if(comment?.required)setValue(comment,'ありがとうございました。');
    identity(a);if(getId(a.site,location.href)&&getId(a.site,location.href)!==expected)throw new Error('送信前に取引が変わりました');
    const selected=positive.type==='radio'?positive.checked:positive.getAttribute('aria-pressed')==='true'||positive.getAttribute('aria-checked')==='true';
    if(!selected)throw new Error('良い評価が選択されていません');
    if(!visible(submit)||submit.disabled)throw new Error('評価送信ボタンが利用できません');
    submit.click();return {clicked:true};
  }
  function selectorFor(e){
    if(e.id&&document.querySelectorAll('#'+CSS.escape(e.id)).length===1)return '#'+CSS.escape(e.id);
    for(const attr of ['data-testid','aria-label'])if(e.getAttribute(attr)){const s=`${e.tagName.toLowerCase()}[${attr}="${CSS.escape(e.getAttribute(attr))}"]`;if(document.querySelectorAll(s).length===1)return s;}
    const parts=[];let node=e;while(node&&node!==document.body){let part=node.tagName.toLowerCase();const siblings=node.parentElement?[...node.parentElement.children].filter(x=>x.tagName===node.tagName):[];if(siblings.length>1)part+=':nth-of-type('+(siblings.indexOf(node)+1)+')';parts.unshift(part);node=node.parentElement;}
    return 'body > '+parts.join(' > ');
  }
  let cancelPicker;
  async function pickIdentity(){
    cancelPicker?.();
    return new Promise(resolve=>{
      const note=document.createElement('div');note.textContent='ログイン中の自分のアカウント名をクリックしてください（Escで中止）';Object.assign(note.style,{position:'fixed',top:'12px',left:'12px',zIndex:2147483647,padding:'16px',background:'#efe5d2',color:'#493d31',border:'2px solid #8a725a',fontSize:'16px'});document.body.append(note);
      let timer;
      function cleanup(){document.removeEventListener('click',click,true);document.removeEventListener('keydown',key,true);clearTimeout(timer);note.remove();cancelPicker=null;}
      function click(event){if(event.target===note)return;event.preventDefault();event.stopImmediatePropagation();const e=event.target;const text=norm(e.innerText||e.getAttribute('aria-label'));if(!text||text.length>200){note.textContent='短いアカウント名の表示を選んでください';return;}const result={selector:selectorFor(e),text};cleanup();resolve({identity:result,url:location.href});}
      function key(e){if(e.key==='Escape'){cleanup();resolve({cancelled:true});}}
      cancelPicker=()=>{cleanup();resolve({cancelled:true});};timer=setTimeout(cancelPicker,120000);
      document.addEventListener('click',click,true);document.addEventListener('keydown',key,true);
    });
  }
  function accountCandidates(site){
    const problem=authProblem();if(problem)throw new Error(problem);safeUrl(site,location.href);
    if(site==='mercari'&&location.pathname!=='/mypage/purchases')throw new Error('メルカリの購入した商品を開いてください');
    if(site==='flea'&&!/^\/(?:my|mypage)(?:\/|$)/.test(location.pathname))throw new Error('Yahoo!フリマの購入一覧を開いてください');
    if(!['mercari','flea'].includes(site))throw new Error('自動登録の対象サイトではありません');
    const root=document.querySelector('main')||document.body;
    if(!/購入した商品|購入履歴|購入した取引/.test(norm(root.innerText)))throw new Error('購入者側の一覧を確認できません');
    const marker='[data-testid="user-name"],[data-testid="nickname"],[data-testid="account-name"],[data-testid="user-info"],[class*="userName"],[class*="nickname"],a[href="/mypage"],a[href="/my"],a[href^="/user/profile/"]';
    const candidates=[...document.querySelectorAll('header,[role="banner"]')].flatMap(e=>[...e.querySelectorAll(site==='mercari'?marker+',button p':marker)]);
    return [...new Set(candidates)].filter(e=>{const t=norm(e.innerText||e.getAttribute('aria-label'));return visible(e)&&t.length>0&&t.length<=80&&!/^(マイページ|プロフィール|アカウント|メニュー|ログイン|会員登録)$/.test(t)&&!/ログイン|ログアウト|出品|購入|商品検索/.test(t);}).filter((e,i,rows)=>!rows.some(other=>other!==e&&e.contains(other)&&norm(e.innerText)===norm(other.innerText)));
  }
  function diagnosticUrl(href){try{const site=Object.keys({mercari:1,auctions:1,flea:1,rakuma:1}).find(site=>{try{return !!safeUrl(site,href);}catch{return false;}});if(!site)return null;const u=new URL(href);const result=new URL(u.origin+u.pathname);for(const key of ['aID','aid','auctionID','item_id']){const id=u.searchParams.get(key);if(id&&/^(?:[a-zA-Z]\d+|[a-f0-9]{32})$/.test(id))result.searchParams.set(key,id);}return result.href;}catch{return null;}}
  function diagnostic(){
    const root=document.querySelector('main')||document.body;
    // 診断は構造・操作ラベルのみ。本文、住所、メッセージ、入力値は収集しない。
    let accountHints=[];
    for(const site of ['mercari','flea']){try{accountHints=accountCandidates(site).map(e=>({selector:selectorFor(e),text:norm(e.innerText||e.getAttribute('aria-label'))}));break;}catch{}}
    const listState={visibility:document.visibilityState,anchorCount:root.querySelectorAll('a[href]').length,imageCount:root.querySelectorAll('img').length,loadedImageCount:[...root.querySelectorAll('img')].filter(e=>e.complete&&e.naturalWidth>0).length,busyCount:root.querySelectorAll('[aria-busy="true"],[role="progressbar"]').length,itemMarkers:[...root.querySelectorAll('[data-testid]')].map(e=>e.getAttribute('data-testid')).filter(v=>/item|purchas|transaction|loading|skeleton/i.test(v)).slice(0,30),errors:['エラーが発生','時間をおいて','読み込めません','通信に失敗'].filter(t=>norm(root.innerText).includes(t))};
    return {accountHints,listState,headerNames:[...document.querySelectorAll('header button p,header p > a')].filter(visible).map(e=>({text:norm(e.innerText),selector:selectorFor(e)})).filter(x=>x.text.length<=80).slice(0,10),linkSamples:[...root.querySelectorAll('a[href]')].map(e=>({url:diagnosticUrl(e.href),selector:selectorFor(e)})).filter(x=>x.url).slice(0,40),url:location.origin+location.pathname,title:document.title,auth:authProblem(),mainCount:document.querySelectorAll('main').length,
      headings:[...root.querySelectorAll('h1,h2,h3')].map(e=>({text:norm(e.innerText),selector:selectorFor(e)})).filter(x=>/購入|落札|取引|受取|受け取り|評価|発送/.test(x.text)).slice(0,20),
      controls:[...root.querySelectorAll('button,input[type="submit"],input[type="radio"],input[type="checkbox"],textarea')].filter(visible).map(e=>({tag:e.tagName,type:e.type,required:e.required,selector:selectorFor(e),text:e.tagName==='TEXTAREA'?'':norm(e.labels?.[0]?.innerText||controlText(e))})).slice(0,50),
      transactionLinks:[...root.querySelectorAll('a[href]')].filter(e=>/transaction|trade|deal|contact\.auctions/.test(e.href)).map(e=>({url:diagnosticUrl(e.href),selector:selectorFor(e)})).filter(x=>x.url).slice(0,30)};
  }
  chrome.runtime.onMessage.addListener((m,sender,respond)=>{
    if(sender.id!==chrome.runtime.id||!m?.type?.startsWith('fm:'))return false;
    (async()=>{
      if(m.type==='fm:diagnostic')return {...diagnostic(),headerShape:[...document.querySelectorAll('header,[role="banner"]')].map(root=>({width:innerWidth,text:norm(root.innerText).slice(0,600),nodes:[...root.querySelectorAll('p,a,button,img,span')].map(e=>({tag:e.tagName,visible:visible(e),text:norm(e.textContent).slice(0,120),aria:e.getAttribute('aria-label'),alt:e.getAttribute('alt'),testId:e.getAttribute('data-testid'),selector:selectorFor(e)})).filter(e=>e.text||e.aria||e.alt).slice(0,60)}))};
      if(m.type==='fm:rakumaIdentity'){
        const problem=authProblem();if(problem)throw new Error(problem);
        if(location.origin!=='https://fril.jp'||location.pathname!=='/mypage')throw new Error('ラクマのマイページを確認できません');
        const names=[...document.querySelectorAll('h1,h2,h3')].filter(e=>visible(e)&&/^.{1,100}さんのマイページ$/.test(norm(e.innerText)));
        if(names.length!==1)throw new Error('ラクマのマイページの名前を1件に確定できません');
        return {identity:{selector:selectorFor(names[0]),text:norm(names[0].innerText),pageUrl:'https://fril.jp/mypage'}};
      }
      if(m.type==='fm:identity'){
        const problem=authProblem();if(problem)return {auth:problem};
        const a=m.account;
        const identityUrl=a?.identity?.pageUrl||((a?.site==='mercari'&&a.listUrl==='https://jp.mercari.com/mypage/purchases')||(a?.site==='auctions'&&a.listUrl==='https://auctions.yahoo.co.jp/my/won')||(a?.site==='flea'&&a.listUrl==='https://paypayfleamarket.yahoo.co.jp/my/purchase')?a.listUrl:null);
        if(!identityUrl||location.href!==identityUrl)throw new Error('登録したアカウント確認ページではありません');
        safeUrl(a.site,location.href);
        if(a.site==='rakuma'){
          if(location.href!=='https://fril.jp/mypage')throw new Error('ラクマのマイページを確認できません');
        }else if(a.site==='auctions'){if(location.href!=='https://auctions.yahoo.co.jp/my/won'||!document.querySelector('main')?.innerText.includes('落札分'))throw new Error('ヤフオクの落札分を確認できません');}
        else if(a.site==='flea'){if(location.href!=='https://paypayfleamarket.yahoo.co.jp/my/purchase'||!document.querySelector('main')?.innerText.includes('購入'))throw new Error('Yahoo!フリマの購入一覧を確認できません');}
        else if(a.site==='mercari'){const until=Date.now()+8000;while(true){try{identity({...a,_identityConfirmed:false});break;}catch(e){if(Date.now()>=until)throw e;const problem=authProblem();if(problem)return {auth:problem};await new Promise(r=>setTimeout(r,350));}}}
        else throw new Error('対象サイトではありません');
        identity({...a,_identityConfirmed:false});return {confirmed:true};
      }
      if(m.type==='fm:purchaseInspect'){const a=m.account;const auth=authProblem();if(auth)return {auth};identity(a);const root=document.querySelector('main')||document.body,seen=new Set(),rows=[];for(const e of root.querySelectorAll('a[href]')){let id;try{id=getId(a.site,safeUrl(a.site,e.href));}catch{continue;}if(!id||seen.has(id))continue;seen.add(id);const row=e.closest('li,tr,article,[data-testid="transaction"],[data-testid*="item" i]')||e.parentElement;rows.push({id,url:e.href,text:norm(row.innerText).slice(0,900),leaves:[...row.querySelectorAll('*')].filter(x=>visible(x)&&!x.children.length).map(x=>({tag:x.tagName,cls:x.className,text:norm(x.innerText)})).filter(x=>x.text).slice(0,12)});if(rows.length>=8)break;}let extracted=[],extractionError=null;try{extracted=list(a,{purchaseImport:true,includeCompleted:true}).purchaseRows;}catch(e){extractionError=e.message;}return {rows,heading:norm(root.innerText).slice(0,450),extracted,extractionError};}if(m.type==='fm:inventoryInspect'){const a=m.account;const auth=authProblem();if(auth)return {auth};identity(a);const root=one('main'),seen=new Set(),rows=[];for(const e of root.querySelectorAll('a[href]')){let id;try{id=getId(a.site,safeUrl(a.site,e.href));}catch{continue;}if(!id||seen.has(id))continue;seen.add(id);const row=e.closest('li,tr,article,[data-testid="transaction"],[data-testid*="item" i]')||e.parentElement;rows.push({itemId:id,text:norm(row.innerText).slice(0,1200),times:[...row.querySelectorAll('time')].map(x=>({text:norm(x.innerText),datetime:x.getAttribute('datetime')})),ancestors:[row,row.parentElement].filter(x=>root.contains(x)).map(x=>({tag:x.tagName,text:norm(x.innerText).slice(0,1200)}))});if(rows.length>=20)break;}return {url:diagnosticUrl(location.href),rows};}
      if(m.type==='fm:autoIdentity'){
        const rows=accountCandidates(m.site);
        if(rows.length!==1)throw new Error('ログイン中の名前を1件に確定できません。「現在の画面の診断を保存」で確認できます');
        return {identity:{selector:selectorFor(rows[0]),text:norm(rows[0].innerText||rows[0].getAttribute('aria-label')),pageUrl:location.origin+location.pathname}};
      }
      if(m.type==='fm:pick')return pickIdentity();
      if(m.type==='fm:list')return readList(m.account,m.recipe||{});
      if(m.type==='fm:purchaseMore')return purchaseMore(m.account,m.recipe||{},m.seenIds||[]);if(m.type==='fm:purchaseDetail')return purchaseDetail(m.account,m.recipe||{},m.itemId);if(m.type==='fm:detail')return readDetail(m.account,m.recipe||{});
      if(m.type==='fm:messageDetail')return conversation(m.account,m.recipe||{});
      if(m.type==='fm:sendMessage')return sendMarketplaceMessage(m.account,m.recipe||{},m.itemId,m.body);
      if(m.type==='fm:preflight'){receiptPreflight(m.account,m.recipe,m.itemId);return {ok:true};}
      if(m.type==='fm:submit')return submitReceipt(m.account,m.recipe,m.itemId);
      if(m.type==='fm:success'){const problem=authProblem();if(problem)return {auth:problem};identity(m.account);const root=one(m.recipe.scope||'main');const d=detail(m.account,m.recipe);return {success:d.itemId===m.itemId&&norm(root.innerText).includes(m.recipe.successText)};}
      throw new Error('未知の操作です');
    })().then(value=>respond({ok:true,value}),error=>respond({ok:false,error:error.message}));return true;
  });
})();
