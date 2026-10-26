# 管理・納品アプリの公開と失敗時の復旧

## 公開回数を浪費しない設定

- 両アプリの `vercel.json` は `git.deploymentEnabled = { "**": false, "main": true }`。作業ブランチへの保存ごとの自動プレビューを止め、mainへの統合時に公開する。
- Pull Requestの型チェック・テスト・ビルドはGitHub Actionsで引き続き行う。確認に使うプレビューが本当に必要な場合だけ、許可された範囲で明示的に作成する。
- 同じコミットの作成済み／作成中デプロイを確認し、Git公開の後に無条件で同じAPI公開を重ねない。小さな修正は可能な範囲で一つの公開にまとめる。
- 管理・納品とも `/` と `/index.html` は `no-cache, max-age=0, must-revalidate`。HTMLを再検証し、ハッシュ付きアセットで最新版を読む。

## 対象の確認

リポジトリは `kazuki101213/test-repo`、GitHub repo IDは `1377878664`。実行前に対象と最新mainを再確認する。以下はこのアプリ専用の対応表であり、別アプリには流用しない。

| 公開ドメイン | Vercel project ID | アプリ |
|---|---|---|
| bussan-admin.vercel.app | prj_N4QH55G78owhWhKnV7J8GH49FdI1 | apps/admin |
| test-repo-delivery.vercel.app | prj_9qZ0O97hTwljYxFok10DSTJKqgts | apps/delivery |
| bussan-delivery.vercel.app | prj_USYeSHtiW0i8uvTArAv8o2xgQoDs | apps/delivery |

APIはこの作業で利用中の認証済み接続を優先する。名前からteamIdを推測して付加しない。明示スコープが必要な場合は接続と対象の所属を確認する。サービスロールキーやトークンをこの文書・ログ・公開ファイルへ書かない。

## 公開手順

1. 依頼内容・実装・必要なチェック・mainへの統合を完了し、公開したい正確なコミットSHAを記録する。DB変更があれば互換性と適用結果も確認する。
2. 対象プロジェクトの既存デプロイと公開URLを調べる。同じSHAが作成中なら、その結果を適切な間隔で待ち、新しく作らない。
3. 同じSHAのREADYデプロイがあれば再利用する。PRコミットとmergeコミットでSHAが違うときは、Git treeが完全一致することを確認する。未完了の途中版や単に一番新しいREADYを選ばない。
4. 完成済みビルドへの切り替えは `assign_alias` で同じプロジェクトの公開ドメインを割り当てる。まずproject ID・SHA/tree・READY・環境変数の適合を確認する。Preview成果物へのalias切り替えは、サイト配信の切り替えであり、本番デプロイの作成や正式な昇格と混同しない。Previewからの正式な本番化には再ビルドが必要な場合があり、staged production用promoteを無条件に使わない。
5. 最新修正を含む完成物がなければ、既存接続の `create_deployment` で対象の最新mainを `target: "production"` として公開できるか確認する。既存プロジェクト・Git接続を使用し、新しいアカウントやプロジェクトを作らない。

API呼び出しの形（値は対象表・その時点で検証したSHAを使う）:

```js
create_deployment({
  requestBody: {
    name: projectName,
    project: projectId,
    target: "production",
    gitSource: { type: "github", repoId: 1377878664, ref: verifiedMainSha }
  }
});
```

6. 新規作成が受理されたらREADYまで確認する。ドメインが最新成果物を参照していなければ、正しいプロジェクト内でaliasを切り替える。別のプロジェクトへドメインを移さない。
7. 各公開ドメインを再取得し、デプロイID・SHA・READY・target・aliasエラーの有無を確認する。配信HTMLのアセットと今回の実装を照合する。実画面も可能な範囲で確認し、入力・送信・登録・発送などのユーザーデータ操作は検証のためだけに実行しない。
8. 古い画面が残る場合は、通常の再読み込みや `?release=<検証済みSHAの短縮形>` で最新HTMLを読み、実際のアセットを確認する。キャッシュ問題と未公開を区別する。

## 制限・障害で失敗した場合

- Git連携の `Deployment rate limited` だけを根拠に「更新できない」「必ず24時間後」と断定しない。まず上の完成物再利用とAPI経路を確認する。
- `api-deployments-free-per-day` などの実際の制限、Retry-After、対象SHA、試した経路を記録する。CLIが既に使える場合は同じ対象・CLI自身の認証で公式の代替経路も確認できる。資格情報を無断で探したり認証情報を別経路へ流用しない。
- 状態変化やユーザーからの再依頼がある場合は、現在の状態を確認して控えめに再試行する。同じ失敗を連打したり、空コミットやforce指定で公開回数を消費しない。
- 課金・契約変更・新規サービス移転・保護解除は無断で行わない。サービス側の上限や障害が続く場合まで、必ず公開できるとは保証しない。
- 実装／チェック／統合／公開／実際の読み込み確認を分けて記録する。未公開の確認画像を本番画像として提示しない。今後の自動再試行は、実際に設定していない限り約束しない。

## 2026-10-26に実際に成功した経路

最初は同じGit treeのREADY Previewへ同一プロジェクトのaliasを切り替えて配信できた。その後の修正には完成済みビルドがなく、一時はGitとAPIの両方で回数制限を受けた。後の再依頼時に最新mainをAPIで再試行すると受理され、3プロジェクトすべてがproduction/READYになった。従って、古い制限メッセージで判断を固定せず、その時点の状態と正しい成果物を確認する。ただし、同じ方法があらゆる制限や障害を解消するという意味ではない。

## 公式資料

- [Git deploymentEnabled](https://vercel.com/docs/project-configuration/git-configuration)
- [Create a new deployment](https://vercel.com/docs/rest-api/deployments/create-a-new-deployment)
- [Promoting deployments](https://vercel.com/docs/deployments/promoting-a-deployment)
