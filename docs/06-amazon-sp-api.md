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

- 管理者で「Amazon FBA」→「最新の在庫を取得」。次ページも確認。
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
