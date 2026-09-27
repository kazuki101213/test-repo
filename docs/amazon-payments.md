# Amazon ペイメント

- 管理アプリの管理者メニューから利用する。編集担当（purchaser）・納品担当は利用不可。
- Finances API v2024-06-19 `listTransactions`、日本マーケットプレイスを使用。
- 出品者用 Finance and Accounting（財務会計）ロールと、そのロールを含むアプリ認可が必要。
- Amazonの認証値はEdge Function Secretsのみで管理する。既存の4項目を使用する。
- `supabase/migrations/20260927063022_amazon_payment_history.sql` を適用し、`amazon-payments` をデプロイする。
- `verify_jwt=false` は関数内で `Auth.getUser` と `app.is_admin` を検証するため。検証前にAmazonの呼び出しや履歴の読み書きをしない。

## 保存と取得

- ボタン操作で1ページずつ取得・保存する。続きがあるときは「続きを取得・保存」を押す。
- 取得期間は日本時間の日付で最大180日。終了時刻は現在の3分前まで。
- 取引ID、Seller IDのSHA-256ハッシュ、日本のmarketplace IDを複合主キーとしてupsertする。
- 計上日、金額、通貨、状態、注文ID、内訳、支払日、最終取得日時のみを保持する。認証値・生のレスポンス・購入者情報は保存しない。
- 同じ取引の状態変更は最新値へ更新する。変更前の各版を保管する監査ログではない。
- 日付を変えたらページトークンを破棄する。空のページでも次ページがあれば続行可能。
- 保存に失敗したページは同じ期間で再取得できる。取得・保存済みの別ページを削除しない。
- 保存済み履歴は100件ずつ表示する。表示中のページを全取引の合計として扱わない。
- Amazonへの在庫・出品・送金などの更新は一切行わない。FBA在庫の保存方針は変更しない。

## 表示の意味

- RELEASED: 支払対象。銀行口座の着金確認ではない。
- DEFERRED: 保留中。
- DEFERRED_RELEASED: 保留解除・支払対象。
- 金額内訳には親・子階層がある。親と子を二重に足さない。
- 最近48時間の取引がAmazonの応答に含まれない場合がある。

## 招待ログイン

両アプリは `/?setup=1` または招待・再設定リンクからパスワード設定画面を開く。
Supabase AuthのURL許可リストに各本番URLの `/?setup=1` を追加する。
招待メールの送信には独自SMTPの設定が必要。Supabaseの既定SMTPはプロジェクトチーム外へ送れない。
Supabase Authで招待後、運用者がSQL Editorから既存の担当者とアカウントを紐付ける。
担当者紐付け関数 `app.link_login` は一般利用者に公開してはいけない。
新しい担当者を重複作成せず、本人のメールと既存の担当者を照合する。

## 確認

管理・納品・sharedの型チェック、両アプリの本番ビルドを実行する。
Denoテスト: `deno test --no-config --no-lock --node-modules-dir=none --allow-env supabase/functions/amazon-payments/index_test.ts`。
本番での403は在庫件数によるものと決めつけず、ロール・認可・Amazon側の拒否理由を確認する。
