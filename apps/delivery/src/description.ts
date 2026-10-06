import type { ItemCondition } from '@bussan/shared';
import { sourceTemplates } from './descriptionTemplates';

export const PRODUCT_TYPES = ['小物', 'ブルーレイレコーダー', 'モニター', 'テレビ'] as const;
export type DescriptionProduct = typeof PRODUCT_TYPES[number];
export type DescriptionTarget = 'amazon' | 'mercari' | 'yahoo-auction';

export const CONDITIONS_BY_TARGET: Record<DescriptionTarget, string[]> = {
  amazon: ['ほぼ新品', '非常に良い', '良い', '可'],
  mercari: ['新品、未使用', '未使用に近い', '目立った傷や汚れなし', 'やや傷や汚れあり', '傷や汚れあり', '全体的に状態が悪い'],
  'yahoo-auction': ['未使用', '未使用に近い', '目立った傷や汚れなし', 'やや傷や汚れあり', '傷や汚れあり', '全体的に状態が悪い'],
};

const conditionToStored: Record<string, ItemCondition> = {
  '新品、未使用': '新品', 未使用: '新品',
  '未使用に近い': 'ほぼ新品',
  '目立った傷や汚れなし': '非常に良い',
  'やや傷や汚れあり': '良い',
  '傷や汚れあり': '可',
  '全体的に状態が悪い': 'ジャンク',
};

export function storedCondition(target: DescriptionTarget, condition: string): ItemCondition | null {
  if (!condition) return null;
  if (target === 'amazon') return condition as ItemCondition;
  return conditionToStored[condition] ?? null;
}

export function conditionForTarget(target: DescriptionTarget, condition: ItemCondition | null): string {
  if (!condition) return '';
  if (target === 'amazon') return CONDITIONS_BY_TARGET.amazon.includes(condition) ? condition : '非常に良い';
  const targetLabel: Record<ItemCondition, string> = target === 'mercari'
    ? { 新品: '新品、未使用', 再生品: '未使用に近い', 'ほぼ新品': '未使用に近い', '非常に良い': '目立った傷や汚れなし', 良い: 'やや傷や汚れあり', 可: '傷や汚れあり', ジャンク: '全体的に状態が悪い' }
    : { 新品: '未使用', 再生品: '未使用に近い', 'ほぼ新品': '未使用に近い', '非常に良い': '目立った傷や汚れなし', 良い: 'やや傷や汚れあり', 可: '傷や汚れあり', ジャンク: '全体的に状態が悪い' };
  return targetLabel[condition] || '';
}

const recorderAccessories = ['本体', '取扱説明書', '純正リモコン', '代替リモコン', '○○製リモコン', 'B-CASカード', 'B-CASカード×2枚', 'ACASチップ内蔵', '電源ケーブル', '同軸(アンテナ)ケーブル', '同軸(アンテナ)ケーブル×2本', 'HDMIケーブル'];
export function accessoryOptions(product: string) {
  if (product === 'モニター') return ['モニター', 'スタンド', '電源ケーブル', 'HDMIケーブル', 'DPケーブル'];
  if (product === '小物') return ['本体', '付属品完品', '取扱説明書', '電源ケーブル', 'ACアダプター', 'リモコン'];
  return recorderAccessories;
}

function listingTitle(input: { target: DescriptionTarget; product: string; itemNumber: string; modelNo: string; manufacturer: string }) {
  const { target, product, itemNumber, modelNo, manufacturer } = input;
  const model = modelNo.trim() || product;
  const maker = manufacturer.trim();
  if (target === 'mercari') return `【${itemNumber}】${model}${maker ? `　${maker}` : ''}`;
  if (target === 'yahoo-auction') {
    const category = product === 'ブルーレイレコーダー' ? '　ブルーレイレコーダー' : '';
    return `${model}${maker ? `　${maker}` : ''}${category}【${itemNumber}】`;
  }
  return '';
}

function mercariDescription(product: string, skuText: string) {
  const searchTerms: Record<string, string> = {
    'ブルーレイレコーダー': 'ブルーレイレコーダー　ブルーレイプレーヤー　ブルーレイ・ディスク　BD　SONY　ソニー Panasonic　パナソニック　DIGA　ディーガ　SHARP　シャープ　AQUOS　アクオス　TOSHIBA　東芝　とうしば　REGZA　レグザ　B-casカード　mini B-casカード　リモコン　同時録画　電源ケーブル　2ピンケーブル　3ピンケーブル　HDMIケーブル　同軸ケーブル　アンテナケーブル',
    モニター: 'PCモニター　ディスプレイ　液晶モニター　外部モニター　在宅ワーク　テレワーク　デュアルモニター　サブモニター　ゲーミングモニター　テレビ　TV　21インチ　24インチ　27インチ　32インチ　フルHD　WQHD　4K　IPS　144Hz　165Hz　電源ケーブル　2ピンケーブル　3ピンケーブル　HDMIケーブル　同軸ケーブル　アンテナケーブル　DisplayPort　USB-C　高さ調整　縦回転　VESA対応　EIZO　アイ・オー・データ　JAPANNEXT　ソニー　SONY　シャープ　SHARP　デル　Dell　ベンキュー　BenQ　LG　ASUS　Acer　MSI　Samsung　HP　Lenovo　Philips　ViewSonic　AOC　GIGABYTE',
    テレビ: 'テレビ　モニター　TV　21インチ　24インチ　27インチ　32インチ　フルHD　WQHD　4K　IPS　144Hz　165Hz　電源ケーブル　2ピンケーブル　3ピンケーブル　HDMIケーブル　同軸ケーブル　アンテナケーブル　ブルーレイレコーダー　ブルーレイプレーヤー　ブルーレイ・ディスク　BD　SONY　ソニー Panasonic　パナソニック　DIGA　ディーガ　SHARP　シャープ　AQUOS　アクオス　TOSHIBA　東芝　とうしば　REGZA　レグザ　B-casカード　mini B-casカード　リモコン　同時録画',
    小物: 'テレビ　モニター　TV　21インチ　24インチ　27インチ　32インチ　フルHD　WQHD　4K　IPS　144Hz　165Hz　電源ケーブル　2ピンケーブル　3ピンケーブル　HDMIケーブル　同軸ケーブル　アンテナケーブル　ブルーレイレコーダー　ブルーレイプレーヤー　ブルーレイ・ディスク　BD　SONY　ソニー Panasonic　パナソニック　DIGA　ディーガ　SHARP　シャープ　AQUOS　アクオス　TOSHIBA　東芝　とうしば　REGZA　レグザ　B-casカード　mini B-casカード　リモコン　同時録画',
  };
  const intro: Record<string, string> = {
    'ブルーレイレコーダー': 'BD、DVD再生\n地デジ受信、録画\n初期化\n上記動作は確認済みです。\n\n1枚目に写っているもののみです。\n\n即購入OK・コメントなしOK。\n\n素人保管のため神経質な方はご遠慮ください。\n\nご覧いただきありがとうございます。',
    モニター: '動作は確認済みです。\n\n1枚目に写っているもののみです。\n\n素人ではありますが、ドット抜けがないように見えます。\n\n画面に大きな傷は有りません。\n\n目に見えない細かい傷はある場合がございます。\n\n即購入OK・コメントなしOK。\n\n素人保管のため神経質な方はご遠慮ください。\n\nご覧いただきありがとうございます。',
    テレビ: '地デジ受信\n初期化\n上記動作は確認済みです。\n\n1枚目に写っているもののみです。\n\n素人ではありますが、ドット抜けがないように見えます。\n\n画面に大きな傷は有りません。\n\n目に見えない細かい傷はある場合がございます。\n\n即購入OK・コメントなしOK。\n\n素人保管のため神経質な方はご遠慮ください。\n\nご覧いただきありがとうございます。',
    小物: '今まで問題なく使用出来ておりました。\n\n中古品であることを理解してご購入ください。\n\n1枚目に写っているもののみです。\n\n目に見えない細かい傷はある場合がございます。\n\n即購入OK・コメントなしOK。\n\n素人保管のため神経質な方はご遠慮ください。\n\nご覧いただきありがとうございます。',
  };
  return `${intro[product]}\n\nAI生成による検索用\n${searchTerms[product]}${skuText ? `　${skuText}` : ''}`;
}

function yahooAuctionDescription(product: string, condition: string, skuText: string) {
  const damaged = condition === '傷や汚れあり' || condition === '全体的に状態が悪い';
  const recorder = [
    '知人宅で地上波の録画とブルーレイ、DVDの再生で使用してました。',
    '譲り受けた際にリモコンが行方不明になりました。',
    '今現在で確認できないので、現状品になります。',
    '素人保管ですので、ご了承の程よろしくお願いいたします。',
    '素人のため、詳しいことは分かりません。',
    'ご覧いただきありがとうございます。',
    ...(damaged ? ['破損あります。'] : []),
    'タイトルや説明文に誤りがある可能性がありますので、写真を優先してください。',
    'ノークレームノーリターンでお願いします。',
    'AI生成による検索用',
    'ブルーレイレコーダー　ブルーレイプレーヤー　ブルーレイ・ディスク　BD　SONY　ソニー Panasonic　パナソニック　DIGA　ディーガ　SHARP　シャープ　AQUOS　アクオス　TOSHIBA　東芝　とうしば　REGZA　レグザ　B-casカード　mini B-casカード　リモコン　同時録画　電源ケーブル　2ピンケーブル　3ピンケーブル　HDMIケーブル　同軸ケーブル　アンテナケーブル',
  ];
  const monitor = [
    '知人宅で問題なく使用してました。',
    '譲り受けた際にリモコンが行方不明になりました。',
    '今現在で確認できないので、現状品になります。',
    '素人保管ですので、ご了承の程よろしくお願いいたします。',
    '素人のため、詳しいことは分かりません。',
    'ご覧いただきありがとうございます。',
    damaged ? 'きずあります。' : '細かいきずはあります。',
    'タイトルや説明文に誤りがある可能性がありますので、写真を優先してください。',
    'ノークレームノーリターンでお願いします。',
    'AI生成による検索用',
    'PCモニター　ディスプレイ　液晶モニター　外部モニター　在宅ワーク　テレワーク　デュアルモニター　サブモニター　ゲーミングモニター　テレビ　TV　電源ケーブル　2ピンケーブル　3ピンケーブル　HDMIケーブル　同軸ケーブル　アンテナケーブル　21インチ　24インチ　27インチ　32インチ　フルHD　WQHD　4K　IPS　144Hz　165Hz　HDMI　DisplayPort　USB-C　高さ調整　縦回転　VESA対応　EIZO　アイ・オー・データ　JAPANNEXT　ソニー　SONY　シャープ　SHARP　デル　Dell　ベンキュー　BenQ　LG　ASUS　Acer　MSI　Samsung　HP　Lenovo　Philips　ViewSonic　AOC　GIGABYTE',
  ];
  const small = [
    '知人宅で使用してました。',
    '譲り受けた際にリモコンが行方不明になりました。',
    '今現在で確認できないので、現状品になります。',
    '素人保管ですので、ご了承の程よろしくお願いいたします。',
    '素人のため、詳しいことは分かりません。',
    'ご覧いただきありがとうございます。',
    'きずあります。',
    'タイトルや説明文に誤りがある可能性がありますので、写真を優先してください。',
    'ノークレームノーリターンでお願いします。',
    'AI生成による検索用',
    'テレビ　モニター　TV　21インチ　24インチ　27インチ　32インチ　フルHD　WQHD　4K　IPS　144Hz　165Hz　電源ケーブル　2ピンケーブル　3ピンケーブル　HDMIケーブル　同軸ケーブル　アンテナケーブル　ブルーレイレコーダー　ブルーレイプレーヤー　ブルーレイ・ディスク　BD　SONY　ソニー Panasonic　パナソニック　DIGA　ディーガ　SHARP　シャープ　AQUOS　アクオス　TOSHIBA　東芝　とうしば　REGZA　レグザ　B-casカード　mini B-casカード　リモコン　同時録画',
  ];
  const text = (product === 'ブルーレイレコーダー' ? recorder : product === '小物' ? small : monitor).join('\n');
  return skuText ? `${text}\n${skuText}` : text;
}

export function buildDescription(input: {
  product: string; condition: string; accessories: string; year: string; sku?: string; listingSkus?: string[]; itemNumber?: string; modelNo?: string; manufacturer?: string;
  target?: DescriptionTarget; inspected: boolean; cleaned: boolean; salesChannel: string | null;
}): string {
  const { product, condition, accessories, year, target = 'amazon', inspected, cleaned, salesChannel } = input;
  if (!product || !condition || !sourceTemplates[product]) return '';
  if (target !== 'amazon') {
    const itemNumber = input.itemNumber || '';
    const title = listingTitle({ target, product, itemNumber, modelNo: input.modelNo || '', manufacturer: input.manufacturer || '' });
    const listingSkus = Array.from(new Set((input.listingSkus?.length ? input.listingSkus : [input.sku || '']).map(value => value.trim()).filter(Boolean)));
    const skuText = listingSkus.map(value => `【${value}】`).join(' ');
    const body = target === 'mercari' ? mercariDescription(product, skuText) : yahooAuctionDescription(product, condition, skuText);
    return `商品名（${target === 'mercari' ? 'メルカリ' : 'ヤフオク'}）\n${title}\n\n説明文\n${body}`;
  }
  if (!accessories.trim()) return '';
  const source = sourceTemplates[product][condition];
  let text = source ?? sourceTemplates[product]['非常に良い'];
  if (!text) return '';
  text = text.replace(/《同梱物》●【[^】]*】になります。/, `《同梱物》●【 ${accessories.trim()} 】になります。`)
    .replace(/※[^。]*。/g, '')
    .replace(/●【 20○○年製 】になります。/, /^\d{4}$/.test(year) ? `●【 ${year}年製 】になります。` : '');
  if (!source) {
    const conditionText: Record<string, string> = {
      新品: '新品です。', 再生品: '再生品です。', 良い: '傷がございます。', 可: '使用に伴う傷・汚れがございます。', ジャンク: 'ジャンク品です。動作保証はありません。',
    };
    text = text.replace(/●(?:画面に|全体的に|軽微な傷|傷は)[^。]*。/, `●${conditionText[condition] ?? condition}`);
  }
  const verified = inspected && condition !== 'ジャンク';
  if (!verified) {
    text = text.replace(/●[^●《]*(?:動作確認済み|動作を確認済み|再生、地デジ|ドット抜け|音質、映像)[^。]*。/g, '')
      .replace('傷はございますが、動作には問題ございません。', '傷がございます。')
      .replace('軽微な傷はございますが、動作には問題ございません。', '軽微な傷がございます。');
  }
  const workText = inspected && cleaned ? '●経験豊富なスタッフにより、一つ一つ丁寧に【 検品・清掃・アルコール除菌 】をしております。'
    : inspected ? '●一つ一つ丁寧に検品しております。' : cleaned ? '●一つ一つ丁寧に清掃しております。' : '';
  text = text.replace(/●経験豊富なスタッフ[^。]*。/, workText);
  if (!inspected) text = text.replace('●十分な検品をして出品しておりますが、', '●');
  if (condition === '新品') text = text.replace(/●あくまで中古品[^。]*。/, '');
  if (salesChannel !== 'FBA') text = text.replace(/《配送》[^《]*/, '《配送》●配送方法は出品ページをご確認ください。');
  return text.replace(/[　\t]+/g, ' ').replace(/\s*《/g, '\n\n《').replace(/\s*●/g, '\n●').trim();
}
