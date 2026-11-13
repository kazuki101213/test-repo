# Amazon FBA 読み取り専用連携

管理者のみ、Amazon.co.jpのFBA在庫数量と出品状態を取得できます。
APIは getInventorySummaries と searchListingsItems のGETのみを呼び出します。
LWAトークン取得にはPOSTを使います。Amazonへの出品・更新・削除やDBへの保存は行いません。
マーケットプレイスは A1VC38T7YXB528、接続先は https://sellingpartnerapi-fe.amazon.com です。

## Secrets

https://supabase.com/dashboard/project/xgoppuqoqeppckyunnvx/functions/secrets
を開き、Edge Function Secretsに以下の4項目を利用者自身で登録してください。

- AMAZON_LWA_CLIENT_ID
- AMAZON_LWA_CLIENT_SECRET
- AMAZON_LWA_REFRESH_TOKEN
- AMAZON_SELLER_ID

上記はAmazon1として引き続き使用します。Amazon2は上書きせず、次の別名で4項目を追加します。

- AMAZON_2_LWA_CLIENT_ID
- AMAZON_2_LWA_CLIENT_SECRET
- AMAZON_2_LWA_REFRESH_TOKEN
- AMAZON_2_SELLER_ID

同じAmazon開発アプリを両出品者アカウントで認可した場合、Client IDとClient Secretは同じ値を両方へ登録できます。Refresh TokenとSeller IDはそれぞれの出品者アカウントに対応させます。Amazon2の未設定値をAmazon1から自動補完することはありません。同じSeller IDを両方へ登録した場合はAmazon2の処理を停止します。

管理アプリの現在の入口は「在庫」→「Amazon情報更新」で、設定済みのアカウントを順に処理します。FBA在庫取得エンドポイントのリクエストでは `accountId: "amazon-1" | "amazon-2"` を指定し、省略時は従来互換のAmazon1になります。`AmazonInventory.tsx` は現行メニューへ接続されていないため、「Amazon FBA」メニューが存在すると案内しないでください。アカウント別の認証設定を返したり、ブラウザーへ渡したりしません。

実値はチャット・Git・Vercel・VITE_環境変数に入れません。
Supabaseのsb_publishableキーはAmazon認証情報ではありません。
Amazon開発者プロフィールでProduct Listingロールの承認を取得し、アプリ登録でも選択します。
対象セラーからのアプリ認可が必要です。Refresh TokenとSeller IDの対象アカウントを一致させてください。

## デプロイ

GitHub CLI: `gh auth login --hostname github.com --git-protocol https --web`
でブラウザーログイン後、`gh auth setup-git`、`gh auth status`で確認します。
ブラウザーだけのGitHubログインはCLI認証を設定しません。

Supabase CLI: `supabase login` で利用者自身が認証し、以下を実行します。

```sh
supabase functions deploy amazon-fba-inventory --project-ref xgoppuqoqeppckyunnvx --use-api
```

config.tomlのverify_jwt=falseは関数内部でSupabase Auth getUserとapp.is_adminを検証するためです。
未認証・非管理者はAmazon呼び出し前に拒否します。Service Roleキーは使用しません。
SQL・db push・データ移行は不要です。

mainを最新状態と突き合わせ、対象変更だけをpushします。Vercelの管理アプリで対象コミットのProduction/Readyを確認し、Production Domainから開いてください。
納品アプリ・共有パッケージは変更しません。

## 検証とエラー

- 管理者の通常入口は「在庫」→「Amazon情報更新」。FBA取得のみの確認はサーバー側の読み取り専用診断で行い、実在庫へ販売情報を反映する操作と区別する。
- 401: Supabaseログイン切れ。再ログイン。
- 403: 有効な管理者ではない。
- 503: Secrets不足、またはappスキーマの権限照会失敗。表示された原因を確認。
- LWA失敗: Client ID/Secret/Refresh Tokenを確認。
- Amazon 403: Product Listingロール、アプリ認可、Seller IDを確認。
- Amazon 429: 時間をおいて再取得。
- カンマを含むSKUはAmazonの一括検索制約のためエラーにします。
- 数量や出品状態が取得できない場合は0や出品停止と断定しません。
- エラー後は前回取得日時と前回データ表示であることを表示します。

## 公式資料

- https://developer-docs.amazon/sp-api/docs/get-fba-inventory-summaries
- https://developer-docs.amazon/sp-api/docs/search-for-listings-items-by-id
- https://supabase.com/docs/guides/functions/deploy

## 販売先と出品者の対応

新しい販売先は `FBA1`・`FBA2`・`自己発送1`・`自己発送2` です。FBA1/自己発送1はAmazon1（Seller ID `A1WI3OGPE43N2T`）、FBA2/自己発送2はAmazon2（Seller ID `A3E7BXJWH9TP11`）を使います。番号の違いで色は変えず、FBAは薄青、自己発送は薄緑に統一します。旧FBA/自己発送の保存値は互換のため保持し、画面は1として表示します。既存商品を一括更新する処理は行いません。

出品確認のカテゴリ必須チェックはメルカリとヤフオクだけに適用します。Amazonでは販売サイト向けカテゴリを要求せず、登録済みASINへのオファーをListings Items APIで作成します。梱包写真・作業完了日・発送待ちの判定はアカウント番号にかかわらず発送方式で行います。明示的な1/2付き販売先と異なる出品者の売上・返金は自動反映せず確認対象にします。

## Amazonの実出品

納品アプリの出品確認は `amazon-listing-submit` を呼び、保存済みASIN・コンディション・予定販売価格・説明と販売先の出品者IDを使います。FBAは `AMAZON_JP`（在庫数はAmazon管理）、自己発送は `DEFAULT`・1点です。VALIDATION_PREVIEWで内容を確認してから、未登録のSKUにだけPUTします。既存SKUは上書きしません。

Amazonの受付と登録完了は別です。GETでSKU/ASIN/価格/コンディション/配送方式が一致し、ERRORがないことを確認するまで、作業完了日と出品中への移動を確定しません。受付済み・通信結果不明の処理は非公開の履歴に残し、同じ商品を再操作してもPUTを重ねずGETで結果を確認します。古い画面や直接のlisting_complete RPCも、サーバーが保存した直近の確認証跡がなければ拒否します。

関数はAuth.getUserと有効な管理者または納品担当者を確認し、Service Roleは確認履歴の書き込みだけに使います。状態更新は元の利用者の権限で既存RPCを使います。履歴は管理者/担当者のみ閲覧でき、利用者による確認証跡の偽造は禁止です。FBAの登録ができても、未入庫ならまだ購入可能にはなりません。

公式: https://developer-docs.amazon/sp-api/reference/putlistingsitem と https://developer-docs.amazon/sp-api/docs/additional-functionality-fulfillment-inbound

Amazonへの出品では、電池の内蔵・同梱（batteries_included）に同じASINの日本向けカタログ値を使い、値が未登録の場合は「内蔵・同梱されていない」を送信します。電池が必要かどうか（batteries_required）と危険物区分（supplier_declared_dg_hz_regulation）は、Catalog Items APIに値がある場合に送信します。受付後はsummariesでASINとコンディションを照合し、未取得項目があれば画面に表示して再確認します。
