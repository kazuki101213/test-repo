const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const html=fs.readFileSync('apps/delivery/src/bid-calculator/calculator.html','utf8');
const nodes=new Map();
function element(){return {children:[],style:{},appendChild(child){this.children.push(child);}};}
for(const suffix of ['', '_m']){
 nodes.set('shippingBtns'+suffix,element());nodes.set('shippingCost'+suffix,element());
 for(let row=1;row<=3;row++)nodes.set('shippingRow'+row+suffix,element());
}
const document={createElement:element,getElementById:id=>{assert(nodes.has(id),'Unknown input/container '+id);return nodes.get(id);}};
const context=vm.createContext({document});
const scripts=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match=>match[1]);
vm.runInContext(scripts.find(script=>script.includes('function appendMobileShippingPresets')),context);
for(const script of scripts.filter(script=>script.includes('var rows =')))vm.runInContext(script,context);
const expected=[[900,1000],[1100,1200,1300,1400,1500],[1600,1700,1800,1900,2000],[2100,2200,2300,2400,2500]];
const values=row=>row.children.map(button=>Number(button.textContent.replaceAll(',','')));
for(const suffix of ['', '_m']){
 const mobile=nodes.get('shippingBtns'+suffix).children[0];
 assert.deepEqual(mobile.children.map(values),expected,'Mobile amount rows '+suffix);
 for(const row of mobile.children)for(const button of row.children){button.onclick();assert.equal(nodes.get('shippingCost'+suffix).value,Number(button.textContent.replaceAll(',','')));assert.equal(button.type,'button');}
 const desktop=[1,2,3].flatMap(row=>values(nodes.get('shippingRow'+row+suffix)));
 const first=suffix?1500:900,last=suffix?3900:2500;
 assert.deepEqual(desktop,Array.from({length:(last-first)/100+1},(_,index)=>first+index*100),'Desktop amounts remain unchanged '+suffix);
}
assert.equal((html.match(/class="adj-copy"/g)||[]).length,(html.match(/class="adj-label"/g)||[]).length,'Every adjustment description has its own horizontal text container');
console.log('PASS: both mobile calculators use 2/5/5/5 shipping rows, every button sets its amount, desktop amounts and adjustment text remain available');
