export type AmazonAccountId = 'amazon-1' | 'amazon-2';
export class AmazonAccountError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
const fields = ['LWA_CLIENT_ID', 'LWA_CLIENT_SECRET', 'LWA_REFRESH_TOKEN', 'SELLER_ID'] as const;
const namesFor = (id: AmazonAccountId) => fields.map(field => `${id === 'amazon-2' ? 'AMAZON_2_' : 'AMAZON_'}${field}`);
const value = (name: string) => Deno.env.get(name)?.trim() ?? '';
export function amazonAccountId(input: unknown): AmazonAccountId {
  if (input === undefined) return 'amazon-1';
  if (input === 'amazon-1' || input === 'amazon-2') return input;
  throw new AmazonAccountError(400, 'Amazonアカウントの指定が不正です。');
}
export function amazonAccounts() {
  return (['amazon-1', 'amazon-2'] as const).map(id => {
    const names = namesFor(id);
    return { id, label: id === 'amazon-1' ? 'Amazon1' : 'Amazon2', configured: names.every(name => !!value(name)), hasConfiguration: names.some(name => !!value(name)) };
  });
}
export function amazonCredentials(id: AmazonAccountId, requireLwa = true) {
  const names = namesFor(id);
  const required = requireLwa ? names : names.slice(3);
  const missing = required.filter(name => !value(name));
  if (missing.length) throw new AmazonAccountError(503, `Supabase Secretsが未設定です: ${missing.join(', ')}`);
  const [clientId = '', clientSecret = '', refreshToken = '', sellerId = ''] = names.map(value);
  if (id === 'amazon-2' && sellerId === value('AMAZON_SELLER_ID')) {
    throw new AmazonAccountError(503, 'Amazon1とAmazon2のSeller IDが同じです。アカウントごとの設定を確認してください。');
  }
  return { clientId, clientSecret, refreshToken, sellerId };
}
