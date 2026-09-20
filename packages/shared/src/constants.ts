import type { ItemStatus, Marketplace, SalesChannel, ItemCondition, WorkStep, WorkStream } from './types';

export const MARKETPLACES: Marketplace[] = [
  'メルカリ', 'ヤフオク', 'ヤフフリ', 'PayPayフリマ', 'ラクマ', 'オフモール', '店舗', 'その他',
];

export const SALES_CHANNELS: SalesChannel[] = [
  'FBA', '自己発送', 'メルカリ', 'ヤフオク', 'ヤフフリ', 'その他',
];

export const CONDITIONS: ItemCondition[] = [
  '新品', '再生品', 'ほぼ新品', '非常に良い', '良い', '可', 'ジャンク',
];

export const WORK_STREAMS: WorkStream[] = ['テレビ', 'ブルーレイ', '付属品', 'その他'];

export const STATUSES: ItemStatus[] = [
  '仕入済', '入荷済', '作業中', '出荷済', '出品中', '販売済', '返品', '保留', '廃棄',
];

export const STATUS_COLORS: Record<ItemStatus, string> = {
  仕入済: '#94a3b8',
  入荷済: '#38bdf8',
  作業中: '#fbbf24',
  出荷済: '#a78bfa',
  出品中: '#34d399',
  販売済: '#22c55e',
  返品: '#f87171',
  保留: '#cbd5e1',
  廃棄: '#64748b',
};

/** 納品担当者の作業フロー。この順番でアプリに並べる。 */
export const WORK_STEPS: { key: WorkStep; label: string; hint: string }[] = [
  { key: 'arrived',    label: '入荷',        hint: '商品が手元に届いた' },
  { key: 'registered', label: '商品登録',    hint: 'Amazon へ商品登録した' },
  { key: 'inspected',  label: '検品・清掃',  hint: '動作確認と清掃・除菌が済んだ' },
  { key: 'photo',      label: '写真登録',    hint: '商品写真をアップロードした' },
  { key: 'packed',     label: '梱包',        hint: '梱包が完了した' },
  { key: 'shipped',    label: '出荷',        hint: '発送した' },
];

export const PHOTO_BUCKET = 'item-photos';
