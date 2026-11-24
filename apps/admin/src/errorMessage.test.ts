import { describe, expect, it } from 'vitest';
import { errorMessage } from './errorMessage';

describe('errorMessage', () => {
  it('Supabaseのエラーオブジェクトから説明文を取り出す', () => {
    expect(errorMessage({ code: '23505', message: 'duplicate key', details: 'Key (asin)=(X) already exists.' })).toBe('duplicate key Key (asin)=(X) already exists.');
    expect(errorMessage({ code: '42501' })).toBe('データ参照エラー (42501)');
  });
  it('Errorと文字列はそのまま', () => {
    expect(errorMessage(new Error('失敗'))).toBe('失敗');
    expect(errorMessage('x')).toBe('x');
  });
});
