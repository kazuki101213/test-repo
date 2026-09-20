-- =============================================================================
-- マスタ初期データ
--   スプレッドシートの SKU から読み取れる担当者コードをそのまま採用する。
--   （既存 SKU を壊さないために、このコード表は変更しないこと）
-- =============================================================================

-- このコード表は納品管理表 全 3,161 行の SKU から実際に読み取ったもので、
-- 1 コードにつき担当者は 1 人、食い違いは 0 件だった。
insert into app.staff (code, name, role, is_company, is_active) values
  ('AA', '長部一輝',            'admin',     false, true),
  ('EE', '石川秀樹',            'purchaser', false, true),
  ('DD', '久保田ゆかり',        'deliverer', false, true),
  ('HH', '新川水紀',            'deliverer', false, true),
  ('II', '久保田真由',          'deliverer', false, true),
  ('JJ', '神谷愛',              'deliverer', false, true),
  ('GG', '和田知佳',            'deliverer', false, true),
  ('LL', '土井花菜',            'deliverer', false, true),
  ('FF', '株式会社グレイス',    'deliverer', true,  true),
  ('KK', '株式会社コエル',      'deliverer', true,  true),
  ('MM', '株式会社吉光',        'deliverer', true,  true),
  -- 「辞めた方」シートの担当者。過去の SKU が参照するので消さずに残す
  ('BB', '大長美賀',            'deliverer', false, false),
  ('CC', '平岡拓海',            'deliverer', false, false)
on conflict (code) do nothing;

-- 納品管理表の「クレカ」列に現れた支払い手段をすべて登録する
-- （現金・メルカリ残高はカードではないが、支払い元として同じ列で管理されている）
insert into app.payment_cards (name, last4, credit_limit, closing_day, payment_day) values
  ('三井住友',      '0137', null,     '15',  10),
  ('楽天',          '4061', null,     '末',  27),
  ('メルカード',    '5992', 900000,   '末',  26),
  ('PayPay',        '3797', 2000000,  '末',  27),
  ('セゾン',        null,   null,     '末',  4),
  ('アメックス',    null,   null,     '末',  10),
  ('Dカード',       null,   null,     '末',  10),
  ('現金',          null,   null,     null,  null),
  ('メルカリ残高',  null,   null,     null,  null)
on conflict (name) do nothing;

-- Amazon 出品テンプレート用のコンディション変換表
create table if not exists app.condition_map (
  condition app.item_condition primary key,
  amazon_code text not null
);

insert into app.condition_map (condition, amazon_code) values
  ('新品',       'New'),
  ('再生品',     'Refurbished'),
  ('ほぼ新品',   'UsedLikeNew'),
  ('非常に良い', 'UsedVeryGood'),
  ('良い',       'UsedGood'),
  ('可',         'UsedAcceptable'),
  ('ジャンク',   'UsedAcceptable')
on conflict (condition) do nothing;

alter table app.condition_map enable row level security;
grant select on app.condition_map to authenticated;
create policy condition_map_select on app.condition_map
  for select to authenticated using (true);
