import { MARKETPLACES, SALES_CHANNELS } from './constants';
import { salesChannelLabel } from './salesChannels';
import type { Marketplace, SalesChannel } from './types';

const accounts = {
  'メルカリ1': { family: 'メルカリ', id: 'mercari-1' },
  'メルカリ2': { family: 'メルカリ', id: 'mercari-2' },
  'ヤフオク1': { family: 'ヤフオク', id: 'auctions-1' },
  'ヤフオク2': { family: 'ヤフオク', id: 'auctions-2' },
  'Yahoo!フリマ1': { family: 'ヤフフリ', id: 'flea-1' },
  'Yahoo!フリマ2': { family: 'ヤフフリ', id: 'flea-2' },
} as const;

type AccountLabel = keyof typeof accounts;
const labels = Object.keys(accounts) as AccountLabel[];
const sellerLabels = labels.filter(label => accounts[label].family !== 'ヤフフリ');

function account(label: string | null | undefined) {
  return label && Object.hasOwn(accounts, label) ? accounts[label as AccountLabel] : undefined;
}

export function marketplaceAccountLabel(id: string | null | undefined) {
  return labels.find(label => accounts[label].id === id) || '';
}

export function accountLabelFor(family: string | null | undefined, label: string | null | undefined) {
  const normalized = family === 'PayPayフリマ' ? 'ヤフフリ' : family;
  return account(label)?.family === normalized ? label || '' : '';
}

export const SALES_DESTINATIONS = SALES_CHANNELS.flatMap(value => {
  const options = sellerLabels.filter(label => accounts[label].family === value);
  return options.length ? options : [value];
});

export const PURCHASE_SOURCES = MARKETPLACES.flatMap(value => {
  const options = labels.filter(label => accounts[label].family === value);
  return options.length ? options : [value];
});

export function salesDestinationFields(value: string) {
  const selected = sellerLabels.includes(value as AccountLabel) ? account(value) : undefined;
  return {
    sales_channel: (selected?.family || salesChannelLabel(value) || null) as SalesChannel | null,
    sales_account_id: selected?.id ?? null,
  };
}

export function purchaseSourceFields(value: string) {
  const selected = account(value);
  return {
    marketplace: (selected?.family || value) as Marketplace,
    purchase_account_id: selected?.id ?? null,
  };
}

export function marketplaceSelectOptions(options: readonly string[], current: string) {
  return current && !options.includes(current) ? [current, ...options] : options;
}
