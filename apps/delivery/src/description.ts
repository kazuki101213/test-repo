import { sourceTemplates } from './descriptionTemplates';

export const PRODUCT_TYPES = ['小物', 'ブルーレイレコーダー', 'モニター', 'テレビ'] as const;
export type DescriptionProduct = typeof PRODUCT_TYPES[number];
const recorderAccessories = ['本体', '取扱説明書', '純正リモコン', '代替リモコン', 'B-CASカード', 'B-CASカード×2枚', 'ACASチップ内蔵', '電源ケーブル', '同軸(アンテナ)ケーブル', '同軸(アンテナ)ケーブル×2本', 'HDMIケーブル'];
export function accessoryOptions(product: string) {
  if (product === 'モニター') return ['モニター', 'スタンド', '電源ケーブル', 'HDMIケーブル', 'DPケーブル'];
  if (product === '小物') return ['本体', '付属品完品', '取扱説明書', '電源ケーブル', 'ACアダプター', 'リモコン'];
  return recorderAccessories;
}

export function buildDescription(input: {
  product: string; condition: string; accessories: string; year: string;
  inspected: boolean; cleaned: boolean; salesChannel: string | null;
}): string {
  const { product, condition, accessories, year, inspected, cleaned, salesChannel } = input;
  if (!product || !condition || !accessories.trim() || !sourceTemplates[product]) return '';
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
