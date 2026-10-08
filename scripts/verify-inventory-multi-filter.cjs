const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),assert=require('node:assert/strict');
const compile=file=>ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const constants={exports:{}};vm.runInNewContext(compile('packages/shared/src/constants.ts'),constants);
const shared={exports:{},require:()=>constants.exports};vm.runInNewContext(compile('packages/shared/src/stateSearch.ts'),shared);
const match=shared.exports.matchesInventoryFilters;
assert(match({marketplace:'Amazon返品',sales_channel:'FBA',status:'作業中'},{marketplace:['Amazon返品','ヤフオク'],sales_channel:['FBA','自己発送'],status:['作業中','販売済']}));
assert(!match({marketplace:'動作品Amazon返品',sales_channel:'FBA'},{marketplace:['Amazon返品']}));
assert(!match({marketplace:'Amazon返品',sales_channel:'メルカリ'},{marketplace:['Amazon返品'],sales_channel:['FBA']}));
assert(match({marketplace:null},{marketplace:[]}));
function all(n,out=[]){if(!n||typeof n!=='object')return out;if(Array.isArray(n)){n.forEach(v=>all(v,out));return out;}out.push(n);all(n.props?.children,out);return out;}
function text(n){return n==null?'':Array.isArray(n)?n.map(text).join(''):typeof n==='object'?text(n.props?.children):String(n);}
for(const app of ['admin','delivery']){
 let value={},cleanup,focused=false;const listeners={};const ref={current:{open:true,contains:target=>target==='inside',querySelector:()=>({focus(){focused=true;}})}};
 const jsx=(type,props)=>({type,props});const context={exports:{},require:name=>name==='react'?{useRef:()=>ref,useEffect:fn=>{cleanup=fn();}}:name==='react/jsx-runtime'?{jsx,jsxs:jsx}:shared.exports,document:{addEventListener:(name,fn)=>listeners[name]=fn,removeEventListener:(name,fn)=>{assert.equal(listeners[name],fn);delete listeners[name];}}};
 vm.runInNewContext(compile(`apps/${app}/src/components/InventoryStateFilter.tsx`),context);
 let tree;const render=()=>tree=context.exports.default({value,onChange:next=>value=next});render();
 assert.equal(all(tree).filter(n=>n.type==='details').length,1);assert.equal(all(tree).filter(n=>n.type==='select').length,0);
 assert.deepEqual(all(tree).filter(n=>n.type==='legend').map(text),['仕入先','販売先','販売状態']);
 const toggle=(group,option,checked)=>{const fieldset=all(tree).find(n=>n.type==='fieldset'&&all(n).some(v=>v.type==='legend'&&text(v)===group));const label=all(fieldset).find(n=>n.type==='label'&&text(n)===option);assert(label);all(label).find(n=>n.type==='input').props.onChange({target:{checked}});render();};
 toggle('仕入先','Amazon返品',true);toggle('仕入先','ヤフオク',true);toggle('販売先','FBA',true);toggle('販売先','自己発送',true);toggle('販売状態','作業中',true);toggle('販売状態','販売済',true);
 assert.equal(text(all(tree).find(n=>n.type==='summary')),'フィルター（6）');assert.equal(value.marketplace.length,2);assert.equal(value.sales_channel.length,2);assert.equal(value.status.length,2);
 toggle('仕入先','Amazon返品',false);assert.equal(value.marketplace.join(','),'ヤフオク');assert.equal(value.status.length,2);
 listeners.pointerdown({target:'inside'});assert(ref.current.open);listeners.pointerdown({target:'outside'});assert(!ref.current.open);
 ref.current.open=true;listeners.keydown({key:'Escape'});assert(!ref.current.open);assert(focused);
 all(tree).find(n=>n.type==='button'&&text(n)==='すべて解除').props.onClick();render();assert.equal(Object.keys(value).length,0);assert.equal(text(all(tree).find(n=>n.type==='summary')),'フィルター');
 cleanup();assert.equal(Object.keys(listeners).length,0);
}
console.log('Both real filter components: one menu, multi-select OR/AND, exact return matching, clear, keyboard, outside click and cleanup passed');
