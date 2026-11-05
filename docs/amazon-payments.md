# Amazon ペイメント

- 管理アプリの管理者メニューから利用する。編集担当（purchaser）・納品担当は利用不可。
- Finances API v2024-06-19 `listTransactions`、日本マーケットプレイスを使用。
- 出品者用 Finance and Accounting（財務会計）ロールと、そのロールを含むアプリ認可が必要。
- Amazonの認証値はEdge Function Secretsのみで管理する。既存の4項目を使用する。
- Amazon1は既存の4項目、Amazon2は `AMAZON_2_LWA_CLIENT_ID` / `AMAZON_2_LWA_CLIENT_SECRET` / `AMAZON_2_LWA_REFRESH_TOKEN` / `AMAZON_2_SELLER_ID` を使用する。詳細は `06-amazon-sp-api.md`。
- 「Amazon情報更新」と日次更新は、設定があるアカウントを順に処理する。一方の失敗で他方を停止せず、失敗したアカウントを表示する。未完成の設定も失敗として知らせ、黙って飛ばさない。
- 全アクションの `accountId` で対象を固定し、ページ情報・保存履歴・照合はSeller IDのハッシュごとに分離する。省略時はAmazon1。`accounts` は管理者認証後、名前・設定有無のみを返す。秘密値は返さない。
- 日次の全アカウント処理は、全成功200、一部失敗207、全失敗503とアカウント別結果を返す。`diagnose` は既存の日次認証が必要な読み取り専用の接続診断で、データの反映はしない。
- 接続診断はSellers/FBA/Financesに加え、設定したSeller IDに対するListingsと、Orders v2026のPROCEEDSだけを最大1件確認する。注文が見つかった場合はアプリと同じgetOrderも確認し、状態・応答形式の可否だけを返す。注文ID・注文内容・認証値は返さず、履歴保存や在庫反映もしない。
- `supabase/migrations/20260927063022_amazon_payment_history.sql` を適用し、`amazon-payments` をデプロイする。
- `verify_jwt=false` は関数内で `Auth.getUser` と `app.is_admin` を検証するため。検証前にAmazonの呼び出しや履歴の読み書きをしない。

## 保存と取得

- ボタン操作で1ページずつ取得・保存する。続きがあるときは「続きを取得・保存」を押す。
- 取得期間は日本時間の日付で最大180日。終了時刻は現在の3分前まで。
- 全期間の手動更新は、従来の開始日下限2010年以降の最古の仕入日を採用する。0026年などの旧データが原因で数千年分を走査しない。仕入日自体はこの処理では訂正しない。
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
