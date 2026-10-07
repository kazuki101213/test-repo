# 納品アプリのWeb Push

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
- 本番データを使う回帰確認: `scripts/verify-delivery-push-transaction.sql` (全変更ROLLBACK、HTTP呼出しなし)。新規DBのfixtureではない。
- 実機の許可と受信は、各利用者が「テスト通知」で確認する。
