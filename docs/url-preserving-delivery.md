# 配布URLを維持した配信

管理: https://bussan-admin.vercel.app/
納品: https://test-repo-delivery.vercel.app/

GitHub PagesのCIで既存のPages版に加え、base=/の成果物をserve/admin、serve/deliveryへ公開する。
Vercelのproject-level routing rulesでそれぞれの正式URLからこの成果物へ外部rewriteする。
HTTP redirectを使わないため、ログインorigin、通知のscope、ホーム画面アイコン、利用者のURLは維持する。
認証・写真・通知のAPIは既存Supabaseを利用し、HTML/JS/CSS/manifest/swだけをこの配信先から取得する。

ルールの順序は静的ファイル（assets、icon、manifest、sw、release.json）を先に、その他のパスをindex.htmlへ後にする。
HTML、manifest、swはCache-Control: no-cacheを返す。release.jsonで公開commitを確認できる。
更新はmainのPages workflowが完了すれば反映され、Vercelの新規deploymentを作る必要がない。
同じVercel projectの新しい通常deploymentを公開してもproject-level rewriteは有効なままなので、
この方式を終了する場合はルーティングのHistoryから前のバージョンに戻す。
URL変更、プラン変更、秘密鍵公開は不要。
