import type { ItemStatus, Marketplace, SalesChannel, ItemCondition, WorkStep, WorkStream } from './types';

export const MARKETPLACES: Marketplace[] = [
  'メルカリ', 'ヤフオク', 'ヤフフリ', 'PayPayフリマ', 'ラクマ', 'ジモティー',
  'オフモール', '2ndストリート', 'トレジャーファクトリー', '楽天', '店舗',
  'Amazon返品', '動作品Amazon返品', 'Amazon', 'Yahoo！ショッピング', 'その他',
];

export const SALES_CHANNELS: SalesChannel[] = [
  'FBA', '自己発送', 'メルカリ', 'ヤフオク', 'ヤフフリ', 'その他',
];

export const CONDITIONS: ItemCondition[] = [
  '新品', '再生品', 'ほぼ新品', '非常に良い', '良い', '可', 'ジャンク',
];

export const WORK_STREAMS: WorkStream[] = ['テレビ', 'ブルーレイ', '付属品', 'その他'];

export const STATUSES: ItemStatus[] = ["受取前","検品中","Amazon返送依頼","Amazon補填申請中","商品登録前","出品中","取引中","販売済","返品処理","動作不良"];

export const HELD_STATUSES: ItemStatus[] = ["受取前","検品中","Amazon返送依頼","Amazon補填申請中","商品登録前","動作不良"];

export const STATUS_COLORS: Record<ItemStatus,string> = {
  '受取前': '#cbd5e1',
  '検品中': '#fbbf24',
  'Amazon返送依頼': '#c4b5fd',
  'Amazon補填申請中': '#f9a8d4',
  '商品登録前': '#93c5fd',
  '出品中': '#34d399',
  '取引中': '#7dd3fc',
  '販売済': '#22c55e',
  '返品処理': '#f87171',
  '動作不良': '#fb923c'
};

/** 納品担当者の作業フロー。この順番でアプリに並べる。 */
export const WORK_STEPS: { key: WorkStep; label: string; hint: string }[] = [
  { key: 'inspection_cleaning', label: '検品・清掃', hint: '' },
  { key: 'listing', label: '商品登録・写真登録', hint: '' },
  { key: 'packed', label: '梱包', hint: '' },
  { key: 'shipped', label: '出荷', hint: '' },
];

export const PHOTO_BUCKET = 'item-photos';
