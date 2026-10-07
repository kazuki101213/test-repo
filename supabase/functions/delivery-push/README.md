# 管理・納品アプリのWeb Push

管理アプリの配布URLは `https://bussan-admin.vercel.app/` を維持する。
管理アプリも別のホーム画面アイコンから「通知を有効にする」で設定する。
購読のapp_kindで管理と納品を分け、片方の停止・ログアウトが他方の設定を変更しない。
APIのapp省略は既存納品クライアントとの互換性のためdeliveryとして扱う。

管理アプリは新しい動作不良報告、販売等の作業、写真確認、請求書・領収書確認を対象にする。
管理者には全対象、仕入担当者には自分の担当商品の動作不良報告だけを送る。
送信直前に権限と未完了状態を再確認し、同じ担当者・請求月の書類は最新タスクにまとめる。
通知クリックはダッシュボードの対象行、写真確認、書類確認へ移動する。すでに完了・権限変更済みの場合は画面にその旨を示す。
管理タスク追加者自身も通知対象とする。過去タスクの一斉送信は行わない。

配布URLは `https://test-repo-delivery.vercel.app/` を維持する。
利用者はホーム画面からログインし、「通知を有効にする」でOSの許可を出す。
iPhoneはiOS 16.4以降、ホーム画面に追加して開く必要がある。OSの消音・集中モード・通知設定によって音が鳴らない場合がある。

## 対象と既読

- 管理者・仕入担当者からの動作不良返信、写真承認、新しい担当割当をDBトリガーで記録する。
- 担当納品者と管理者に送る。操作した本人への通知は作成しない。
- 通知登録より前のイベントは送らない。既存商品の一斉通知・既読の変更は行わない。
- 配信時に在籍・担当割当・写真承認時刻・既読を再確認する。
- 通知を押すと同じアプリの対象商品詳細へ移動する。既存の詳細取得成功時の処理で返信・写真承認を既読にする。
- ログアウト時にこの端末の配信を停止する。別端末の設定は変更しない。

## 初回の本番設定

1. migration `delivery_web_push` を適用し、`delivery-push` Edge Functionをデプロイする。
2. 正式納品originから管理者として `{"action":"setup"}` を認証付きで呼ぶ。
   VAPID秘密鍵・配信認証トークンはサーバー内で生成し、Supabase Vaultに暗号化保存する。
   公開鍵だけを利用者へ返す。繰り返しsetupしても秘密鍵は更新しない。
3. setupでpg_cronジョブ `delivery-task-web-push` を毎分登録する。
   `app.kick_delivery_push()` は送信対象があるときだけEdge Functionを呼ぶ。

ブラウザ側の設定APIはAuth.getUser・profiles・active staffのロールで検証する。
配信APIはVaultの専用トークンを検証するため、`verify_jwt=false` とする。
購読先はApple/FCM/MozillaのHTTPSホストに限定し、P-256公開鍵を検証する。
購読情報・キュー・秘密鍵RPCはanon/authenticatedからアクセス不可。

## 配信と再送

イベント/端末ごとに一意の配信行を作り、20件ずつSKIP LOCKEDで取得、5分のリースで同時配信を防ぐ。
成功を記録し、期限切れ購読(404/410)は停止する。通信障害・429・サーバー障害は最大5回再試行。
古いイベントは24時間で対象外になる。通知tagは商品/種類ごとに固定し、同じ通知を端末上でまとめる。
Pushサービスが受付した直後にプロセスが終了した場合は再試行される可能性があり、厳密なexactly-once配信ではない。

## 検証

- Deno: `deno check --no-config --node-modules-dir=auto supabase/functions/delivery-push/index.ts`
- Deno: `deno test --no-config supabase/functions/delivery-push/validation_test.ts`
- Node: `node scripts/verify-delivery-push-worker.cjs`
- Node: `node scripts/verify-admin-push-worker.cjs`
- 管理の本番データ回帰確認: `scripts/verify-admin-push-transaction.sql` (全変更ROLLBACK、HTTP呼出しなし)。
- 本番データを使う回帰確認: `scripts/verify-delivery-push-transaction.sql` (全変更ROLLBACK、HTTP呼出しなし)。新規DBのfixtureではない。
- 実機の許可と受信は、各利用者が「テスト通知」で確認する。
