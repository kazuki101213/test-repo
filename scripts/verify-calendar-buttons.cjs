const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),assert=require('node:assert/strict');
const jsx=(type,props)=>({type,props});
const nodes=(node,out=[])=>{if(Array.isArray(node))node.forEach(n=>nodes(n,out));else if(node&&typeof node==='object'){out.push(node);nodes(node.props?.children,out)}return out};
function load(file){
 const ref={current:null},ctx={exports:{},requestAnimationFrame:fn=>fn(),require:name=>name==='react'?{useRef:()=>ref}:name==='react/jsx-runtime'?{jsx,jsxs:jsx}:{}};
 vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,ctx);
 return {render:ctx.exports.default,ref};
}
for(const app of ['admin','delivery']){
 const date=load(`apps/${app}/src/components/DateInput.tsx`);let changed,opened=0,focused=0;
 const props={value:'2026-10-02',required:true,min:'2026-10-01',max:'2026-10-31',disabled:false,onChange:e=>changed=e.currentTarget.value};
 let tree=date.render(props),inputs=nodes(tree).filter(n=>n.type==='input'),button=nodes(tree).find(n=>n.type==='button');
 assert.equal(tree.props.className,'calendar-control');assert.equal(button.props.className,'calendar-button');
 assert.equal(inputs[0].props.value,'2026-10-02');assert.equal(inputs[0].props.required,true);
 assert.equal(inputs[1].props.type,'date');assert.equal(inputs[1].props.min,props.min);assert.equal(inputs[1].props.max,props.max);
 assert.equal(inputs[1].props.className,'calendar-native-picker');
 assert.notEqual(inputs[1].props['aria-hidden'],true,'The native picker remains exposed for direct touch');
 inputs[1].props.onChange({currentTarget:{value:'2026-10-04'}});assert.equal(changed,'2026-10-04','Native touch selection does not depend on showPicker');
 date.ref.current={showPicker(){opened++}};button.props.onClick();assert.equal(opened,1);
 const target={value:'20261003',selectionStart:8,setSelectionRange(){}};
 inputs[0].props.onChange({currentTarget:target});assert.equal(changed,'2026-10-03','Manual date formatting must remain usable');
 date.ref.current={focus(){focused++}};button.props.onClick();assert.equal(focused,1);
 tree=date.render({...props,disabled:true});nodes(tree).find(n=>n.type==='button').props.onClick();
 assert.equal(focused,1);assert(nodes(tree).filter(n=>n.type==='input').every(n=>n.props.disabled));
 const month=load(`apps/${app}/src/components/MonthInput.tsx`);let monthChanged;
 tree=month.render({value:'2026-10',required:true,min:'2026-01',max:'2026-12','aria-label':'対象月',onChange:e=>monthChanged=e.target.value});
 const native=nodes(tree).find(n=>n.type==='input');button=nodes(tree).find(n=>n.type==='button');
 assert.equal(native.props.type,'month');assert.equal(native.props.required,true);assert.equal(native.props.min,'2026-01');
 assert.equal(native.props.max,'2026-12');assert.equal(button.props.className,'calendar-button');
 assert(native.props.className.includes('calendar-native-month-picker'),'Month selection receives direct taps including over its icon');
 assert(tree.props.children.includes(native),'Native touch area belongs to the whole month control');
 native.props.onChange({target:{value:'2026-11'}});assert.equal(monthChanged,'2026-11');
 month.ref.current={showPicker(){opened++}};button.props.onClick();assert.equal(opened,2);
 tree=month.render({value:'2026-10',disabled:true});nodes(tree).find(n=>n.type==='button').props.onClick();assert.equal(opened,2);
}
console.log('Admin/delivery date and month buttons preserve manual entry, picker opening, bounds, required and disabled controls.');
