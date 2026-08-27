# 電撃イスDUEL v4.0.1

12脚のイスを使った、スマートフォン向けターン制心理戦ゲームです。ONLINE対戦は Firebase Hosting / Anonymous Authentication / Realtime Database、AI・Challengeはブラウザ内だけで動作します。

## v4.0の設計

- 常駐Node.jsサーバーと独自WebSocketを廃止
- 罠番号をChoice前に送らないCommit-Reveal方式
- 得点・感電・使用済みイス・勝敗をイベントログから毎回再計算
- 128bitの招待IDをURLのcapabilityとして使用
- Firebase Security Rulesはdefault deny、参加者限定、役割限定、create-only
- Reveal猶予は90秒。Firebaseサーバー時刻をRulesで検証
- 1〜15ターンを交互の役割・前ターン確定順に制限
- ルームは作成から24時間で書き込みを停止し、参加者の再訪時に削除
- Commit不一致など、サーバーだけで裁定できない不整合は「反則勝ち」ではなく「対戦無効」
- AI、Challenge、実績、履歴はローカル動作
- PWA、Safe Area、44px以上の主要タップ領域、画面ズーム対応

## セキュリティ境界

この構成は友人間のカジュアル対戦向けです。Commit-Revealにより罠の事後変更は検出できますが、中央の裁定サーバーはありません。改造クライアント同士の主張が食い違った場合、共有された正式勝敗は確定せず対戦無効になります。ランキング、賞品、公式戦績には信頼できるバックエンドが必要です。

FirebaseのWeb設定値と招待URLはパスワードではありません。招待IDは十分長く推測困難ですが、URLを受け取った人は空いているguest枠を取得できます。読み込み後、アプリは招待IDをブラウザのアドレス欄から除去します。

Sparkプランでは請求は発生しませんが、無料枠を超えるとサービスが停止します。App CheckとFirebase Consoleの利用量監視を推奨します。ルームは24時間で操作不能になり、参加者の再訪時または管理者用cleanupコマンドで削除されます。クライアントだけでは、誰も再訪しない古いルームを確実に物理削除できません。

## 構成

```text
public/
  app.js
  js/
    ai/local-session.js
    firebase/config.js
    firebase/online-session.js
    game/commitment.js
    game/replay.js
    game/rules.js
    storage/local-secrets.js
    vendor/firebase.js
src/firebase-entry.js
database.rules.json
firebase.json
test/
```

`game/replay.js`はRealtime Databaseのイベントを先頭から再生する決定論的エンジンです。Firebase SDKはビルド時だけ`public/js/vendor/firebase.js`へまとめられ、公開環境にNode.jsランタイムは不要です。

## 開発と検証

Node.js 22以上、pnpm 11.19.0を使用します。

```bash
pnpm install --frozen-lockfile
pnpm run build
pnpm run check
pnpm test
pnpm test:rules
```

`test:rules`はJava 21以上とFirebase Realtime Database Emulatorを使用します。

主なテスト対象:

- room / match / turn / UID / seat / nonceをCommitへ束縛
- 正常Revealと改ざんReveal
- イベントからの得点、感電、使用済みイス、勝敗再構築
- 未来イベント・順序違反の無視または対戦無効化
- 第三者read/write拒否
- guest枠の二重取得拒否
- Commit / Choice / Revealの役割制限と上書き・削除拒否
- 親ノード上書き拒否
- Firebaseサーバー時刻によるReveal Timeout
- 期限後RevealとForfeit後Revealの拒否
- 不正prefix、16ターン目以降、未確定の未来ターンの拒否
- 対戦開始前のルーム解放と24時間経過ルームの削除
- ブラウザ再起動後のRevealデータ復元
- PWA、CSP、スマホ向け静的要件

## Firebase公開

1. FirebaseプロジェクトをSparkプランで作成し、Billingアカウントを接続しない
2. Anonymous Authenticationを有効化
3. Realtime Databaseを作成する
4. Firebase CLIで対象プロジェクトを選択する
5. ビルド後、HostingとRulesを公開する

```bash
firebase use --add
pnpm run build
firebase deploy --only hosting,database
pnpm smoke:prod <FirebaseプロジェクトID>
```

Firebase Hostingでは予約URL`/__/firebase/init.json`から設定を取得するため、APIキーを手作業でソースへ貼る必要はありません。

`smoke:prod`は本番環境に独立した匿名クライアントを作り、guest取得・match作成・第三者read拒否まで検証します。検証ルームは管理者権限で削除してください。匿名テストアカウントは、Firebase Authenticationの「30日超の匿名アカウント自動削除」を有効にして整理します。

24時間を超えたルームは、まずdry-runで件数を確認してから削除します。

```bash
pnpm run cleanup:rooms -- <FirebaseプロジェクトID>
pnpm run cleanup:rooms -- <FirebaseプロジェクトID> --execute
```

### App Check

Web用App Checkを有効にする場合は、アプリの起動前に次の公開設定を与えます。site keyは秘密情報ではありません。適用前にFirebase Consoleでメトリクスを確認し、正規ユーザーを拒否しないことを確認してください。

```js
globalThis.__APP_CHECK_SITE_KEY__ = 'YOUR_RECAPTCHA_SITE_KEY';
```

現在の配布物はキー未設定でも動作します。Firebase側でenforcementだけを先に有効化しないでください。

## 運用上の制約

- SparkのRealtime Databaseは100同時接続まで
- Firebase障害・無料枠超過中はONLINE対戦不可
- Anonymous Authのブラウザデータを失うと同じ参加者として復帰できない
- Commit後にサイトデータを消去するとRevealできず、90秒後にタイムアウト終了（通常のブラウザ再起動では復元）
- 意図的切断と通信事故は区別できない
- ONLINE再戦は、新しい招待ルームを作成して行う
- 誰も再訪しない古いルームは管理者がcleanupコマンドで定期削除する

## バージョン

`4.0.1` — Reveal期限競合、未来ターン、二重送信、guest占有、ルーム期限、スマホ再開時の復元を修正。
