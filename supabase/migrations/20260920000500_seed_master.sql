-- =============================================================================
-- マスタ初期データ
--   スプレッドシートの SKU から読み取れる担当者コードをそのまま採用する。
--   （既存 SKU を壊さないために、このコード表は変更しないこと）
-- =============================================================================

insert into app.staff (code, name, role, is_company) values
  ('AA', '長部一輝',            'admin',     false),
  ('EE', '石川秀樹',            'purchaser', false),
  ('DD', '久保田ゆかり',        'deliverer', false),
  ('HH', '新川水紀',            'deliverer', false),
  ('II', '久保田真由',          'deliverer', false),
  ('JJ', '神谷愛',              'deliverer', false),
  ('GG', '和田知佳',            'deliverer', false),
  ('LL', '土井花菜',            'deliverer', false),
  ('FF', '株式会社グレイス',    'deliverer', true),
  ('KK', '株式会社コエル',      'deliverer', true),
  ('MM', '株式会社吉光',        'deliverer', true)
on conflict (code) do nothing;

insert into app.payment_cards (name, last4, credit_limit, closing_day, payment_day) values
  ('三井住友',   '0137', null,     '15',  10),
  ('楽天',       '4061', null,     '末',  27),
  ('メルカード', '5992', 900000,   '末',  26),
  ('PayPay',     '3797', 2000000,  '末',  27),
  ('セゾン',     null,   null,     '末',  4),
  ('アメックス', null,   null,     '末',  10)
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
