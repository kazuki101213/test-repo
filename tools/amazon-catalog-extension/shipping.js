const parcelSizes = [
  [60, 2], [80, 5], [100, 10], [120, 15], [140, 20], [160, 25], [180, 30], [200, 30],
];

export function parcelSize(packageInfo) {
  if (!packageInfo) return '';
  const { sidesMm, weightG } = packageInfo;
  if (sidesMm?.length !== 3 || ![...sidesMm, weightG].every(value => Number.isFinite(value) && value > 0)) return '';
  const totalMm = sidesMm.reduce((sum, side) => sum + side, 0);
  if (Math.max(...sidesMm) > 1700) return '';
  const size = parcelSizes.find(([cm, kg]) => totalMm <= cm * 10 && weightG <= kg * 1000);
  return size ? String(size[0]) : '';
}

export function shippingCategory(categories, title, packageInfo) {
  const categoryText = categories.join(' ');
  if (/モニター(?:アーム|スタンド|用)|ディスプレイ(?:アーム|スタンド|用)/i.test(title)) return '小';
  if (/(?:ブルーレイ|Blu[ -]?ray)[・\s]*(?:(?:ディスク|DVD)[・\s]*)?レコーダー/i.test(categoryText + ' ' + title)) return 'ブ';
  if (/PCモニター|液晶モニター|ゲーミングモニター|ディスプレイ/i.test(categoryText) ||
      /(?:^|[\s>])モニター(?:$|[\s>])/.test(categoryText) ||
      /ゲーミングモニター|液晶モニター|PCモニター/i.test(title)) return 'モ';
  if (/イヤホン|ヘッドホン|ヘッドフォン|ヘッドセット|リモコン|ケーブル|変換アダプタ|充電器|マウス|メモリーカード|USBメモリ/i.test(categoryText + ' ' + title)) return '小';
  return parcelSize(packageInfo) === '60' ? '小' : '';
}

export function catalogShippingSize(category, packageInfo) {
  if (category === 'ブ') return '120';
  if (category === 'モ') return '140';
  return parcelSize(packageInfo);
}
