const makers = [
  {name:'Panasonic',aliases:['panasonic','パナソニック']},
  {name:'SONY',aliases:['sony','ソニー']},
  {name:'SHARP',aliases:['sharp','シャープ']},
  {name:'TOSHIBA',aliases:['toshiba','東芝','トウシバ','トーシバ']},
] as const;
export type MalfunctionMaker=typeof makers[number]['name'];
const smallKana:Record<string,string>={'ァ':'ア','ィ':'イ','ゥ':'ウ','ェ':'エ','ォ':'オ','ャ':'ヤ','ュ':'ユ','ョ':'ヨ','ッ':'ツ','ヮ':'ワ'};
function normalizedMaker(value:string){
 return value.normalize('NFKC').toLowerCase()
  .replace(/[\u3041-\u3096]/g,char=>String.fromCharCode(char.charCodeAt(0)+0x60))
  .replace(/([ァ-ヶ])[-‐‑‒–—―−](?=[ァ-ヶ]|$)/g,'$1ー')
  .replace(/[ァィゥェォャュョッヮ]/g,char=>smallKana[char]!)
  .replace(/[\s\p{P}\p{S}]/gu,'');
}
export function malfunctionMaker(value:string|null|undefined):MalfunctionMaker|null{
 const normalized=normalizedMaker(value??'');
 const matches=makers.filter(maker=>maker.aliases.some(alias=>normalized.includes(normalizedMaker(alias))));
 return matches.length===1?matches[0]!.name:null;
}
