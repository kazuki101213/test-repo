/** Append to the existing search line, retaining the body, fixed terms, blank lines and SKU. */
export function appendListingKeywords(body:string,keywords:string,_previous:string[],sku:string):string {
 const tag=`【${sku}】`, index=body.lastIndexOf(tag);
 const tail=index>=0&&body.slice(index+tag.length).trim()===''?body.slice(index):'';
 const content=tail?body.slice(0,index):body;
 const whitespace=content.match(/\s*$/)?.[0]??'';
 const base=content.slice(0,content.length-whitespace.length);
 // Existing fixed words are kept. Only add words not already present verbatim.
 const terms=keywords.split(/\s+/).filter(Boolean);
 const existing=new Set(base.split(/\s+/));
 const extra=[...new Set(terms)].filter(term=>!existing.has(term)).join(' ');
 return `${base}${base&&extra?' ':''}${extra}${whitespace}${tail}`;
}
