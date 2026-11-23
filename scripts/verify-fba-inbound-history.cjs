// 在庫画面「FBA納品」タブの表示ロジックを確認する。
const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),assert=require('node:assert/strict');
function load(file){const c={exports:{},require:()=>({}),Map,Set,Date,Intl,Number,String,Object};vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,c);return c.exports;}
const eq=(a,b)=>assert.equal(JSON.stringify(a),JSON.stringify(b));
const h=load('apps/admin/src/fbaInboundHistory.ts');

// セラーセントラルの出荷名は発送依頼の時刻（協定世界時）と倉庫コードから決まる（2026-11-21に実画面と照合）。
assert.equal(h.amazonShipmentName('2026-11-15T13:24:08.390Z','TPB6'),'FBA STA (2026/11/15 13:24)-TPB6');
assert.equal(h.amazonShipmentName('2026-11-19T06:10:06.707Z','TPB3'),'FBA STA (2026/11/19 06:10)-TPB3');
assert.equal(h.amazonShipmentName(null,'TPB8'),null);
assert.equal(h.amazonShipmentName('2026-11-15T13:24:08Z',null),null);

const base={id:'p',name:'担当2026/11/15',account:'FBA2',stage:'ready',staff:null,created_at:'2026-11-15T13:10:28Z',updated_at:'2026-11-18T16:00:09Z',received_at:null,has_amazon_plan:true,waiting_amazon:false,dispatch_requested_at:'2026-11-15T13:24:08.390Z',ship_date:'2026-11-19',
  shipments:[{confirmation_id:'FBA15GLPDZWH',warehouse:'TPB6',status:'IN_TRANSIT',tracking:['397494122900'],boxes:1,received:{}}],
  items:[{item_id:'a',sku:'2454-EELL-20261031-1548',title:'2B-C05EW1',serial:2454,status:'出品中',current_sku:'2454-EELL-20261031-1731',published_at:null,released_at:null},{item_id:'b',sku:'2412-EELL-20261013-1013',title:'BDZ-ZW550',serial:2412,status:'出品中',current_sku:'2412-EELL-20261013-1013',published_at:null,released_at:null}]};

assert.equal(h.fbaPlanState({...base,stage:'draft',shipments:[]}),'draft');
assert.equal(h.fbaPlanState({...base,stage:'cancelled'}),'cancelled');
assert.equal(h.fbaPlanState({...base,stage:'placement-confirmed'}),'working');
assert.equal(h.fbaPlanState(base),'transit');
assert.equal(h.fbaPlanState({...base,shipments:[{...base.shipments[0],status:'READY_TO_SHIP'}]}),'waiting');
const receiving={...base,shipments:[{...base.shipments[0],status:'RECEIVING',received:{'2454-EELL-20261031-1548':1}}]};
assert.equal(h.fbaPlanState(receiving),'receiving');
assert.equal(h.receivedCount(receiving),1);
// アプリが全点受領を記録したら、Amazon側の状態が受領中のままでも受領済み。
assert.equal(h.fbaPlanState({...receiving,received_at:'2026-11-18T16:00:09Z'}),'received');
assert.equal(h.fbaPlanState({...base,shipments:[{...base.shipments[0],status:'CLOSED'}]}),'received');

const timeline=h.fbaTimeline({...receiving,received_at:'2026-11-18T16:00:09Z',items:receiving.items.map(i=>({...i,published_at:'2026-11-18T16:00:11Z'}))}).map(e=>e.label);
eq(timeline,['プランを作成','Amazonで出荷を確定（TPB6）','発送日 11/19','追跡番号を登録（397494122900）','Amazonが受領（1/2点）','全点が出品中に反映']);
eq(h.fbaTimeline({...base,stage:'cancelled'}).map(e=>e.label),['プランを作成','プランを取り消し']);

const plans=[base,{...base,id:'c',stage:'cancelled',name:'取消'},{...base,id:'d',account:'FBA1',name:'別'}];
const f=(o)=>h.filterFbaPlans(plans,{account:'',state:'',query:'',showCancelled:false,...o}).map(p=>p.id);
eq(f({}),['p','d']);
eq(f({showCancelled:true}),['p','c','d']);
eq(f({state:'cancelled'}),['c']);
eq(f({account:'FBA1'}),['d']);
// 現在のSKU・出荷番号・型番・出荷名でも探せる。
eq(f({query:'2454-EELL-20261031-1731',account:'FBA2'}),['p']);
eq(f({query:'fba15glpdzwh',account:'FBA2'}),['p']);
eq(f({query:'ＢＤＺ－ＺＷ５５０'.normalize('NFKC'),account:'FBA2'}),['p']);
eq(f({query:'FBA STA (2026/11/15 13:24)-TPB6',account:'FBA2'}),['p']);

const summary=h.fbaSummary([{...base,stage:'draft',shipments:[]},base,{...receiving,received_at:'2026-11-18T16:00:09Z'},{...base,stage:'cancelled'}],new Date('2026-11-21T03:00:00Z'));
eq(summary,{draft:1,open:1,receivedThisMonth:1,itemsThisMonth:4});

// FBA納品は在庫の切り替えで予備の右のタブ。管理者だけが開ける。読み取り専用のRPCで、管理者以外は拒否する。
const app=fs.readFileSync('apps/admin/src/App.tsx','utf8');
assert.match(app,/\{ key: 'spares', label: '予備' \},[^{]*\{ key: 'fba', label: 'FBA納品' \}/);
assert.match(app,/visiblePage === 'fba' && session\.staff\.role === 'admin' && <FbaInboundHistory \/>/);
const page=fs.readFileSync('apps/admin/src/pages/Inventory.tsx','utf8');
assert.doesNotMatch(page,/在庫一覧|inventory-view-tabs|FbaInboundHistory/);
const sql=fs.readFileSync('supabase/migrations/20261121040000_admin_fba_inbound_history.sql','utf8');
assert.match(sql,/not app\.is_admin\(\)/);
assert.match(sql,/revoke all on function app\.admin_fba_inbound_history\(integer\) from public, anon;/);
assert.doesNotMatch(sql,/\b(insert|update|delete)\b\s+(into\s+)?app\./i);
console.log('fba inbound history: ok');
