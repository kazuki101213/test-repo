// Test helper: admin task lists render product links through TaskProductLinks (b58e166).
// Tests that walk a plain {type,props} tree cannot see inside function components, so this
// loads the real component and returns a jsx factory that renders it inline.
const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
const compile=file=>ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
function load(file,require){const context={exports:{},URL,require};vm.runInNewContext(compile(file),context);return context.exports;}
const noticeUrl=load('packages/shared/src/noticeUrl.ts',()=>({}));
/** Pass-through used in place of the shared Supabase lookup: rows keep their own reference fields. */
async function withTaskPurchaseProducts(tasks){return tasks.map(task=>({...task}));}
function taskProductLinks(baseJsx,file='apps/admin/src/components/TaskProductLinks.tsx'){
 let component;
 const jsx=(type,props,key)=>type===component?component(props):baseJsx(type,props,key);
 const module=load(file,id=>id==='@bussan/shared'?noticeUrl:id==='react/jsx-runtime'?{jsx,jsxs:jsx}:{});
 component=module.default;
 return {jsx,module:{__esModule:true,default:component}};
}
module.exports={noticeUrl,withTaskPurchaseProducts,taskProductLinks};
