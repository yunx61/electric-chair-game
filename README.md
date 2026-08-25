# ELECTRIC CHAIR DUEL v3.4

スマートフォンのブラウザで遊ぶ、非公式ファンメイドの心理戦ゲームです。Node.js + WebSocketで、通信対戦とAI対戦に対応しています。

## v3.4 の主な変更

- HOME画面を全面再設計。iPhone 15系（約393×852 CSS px）を基準に、要素同士が重ならず1画面に収まるよう最適化。
- ONLINEの招待は共有ボタン1つに統一。対応端末ではWeb Share APIでiOS/Androidの共有メニューを直接表示。非対応時はリンクをコピー。
- 対戦中の12脚を画面中心の真円状に配置。各イスは円の中心を向くよう角度を自動調整。
- AIキャラクター4名をアニメ風のオリジナル人物イラストへ刷新。
- スマートフォン向けに見出し、得点、説明文、操作ボタンの文字サイズを再調整。
- CHALLENGEモード追加。
  - NO SHOCK：感電0回で勝利
  - SIX TURN：6ターン以内に勝利
  - HIGH RISK：7〜12番のみ、30PT先取、感電2回で敗北
  - SUDDEN DEATH：25PT先取、感電1回で敗北
- AI解放要素：レイ/ゴウは初期開放。ミカはSOLO 2勝、ナギはSOLO 5勝で開放。
- AIの性格に応じたセリフ表示。
- 実績6種、直近10試合の対戦履歴、連勝記録を端末内に保存。
- 既存の通信秘密保持、SAFE後の罠位置公開、結果演出、再接続、BGM/SE設定を維持。


### v3.4 実機レイアウト修正

- iOS Safariの下部ブラウザバーを含む実表示領域でゲーム画面を6領域（上部/接続/スコア/状況/盤面/操作）に再構成。
- AI情報とCHALLENGE情報を同じコンテキスト領域に収め、盤面が下へ押し出される問題を修正。
- ONLINE待機時、AI対戦、CHALLENGEのいずれでも盤面を残り表示領域の中央へ配置。
- セッション確立前の操作を無効化し、「先にルームへ参加してください」がSOLO中に出る競合を修正。
- HOMEの余白配分を再調整し、主要操作が上に固まりすぎないよう画面高に応じて伸縮。
- SAFEで除外済みのイスを盤面から完全に消し、罠公開時のみ必要なイスを再表示。

## 起動

Node.js 18以上。

```bash
npm start
```

`http://localhost:3000` を開きます。

## Renderでの更新を簡単にする

`render.yaml` は GitHub の `main` ブランチ更新をトリガーに自動デプロイする設定です。

今後は原則として：

1. GitHubのリポジトリを最新版で更新
2. `Commit changes`
3. 終了

Render側の `Manual Deploy` は通常不要です。GitHubの最新コミットをRenderが自動でビルド・公開します。

## 通信設計

- 電気イスの現在位置はサーバーだけが保持します。
- 仕掛け中は相手クライアントへ `trapSeat` を送信しません。
- 判定後の `result` フェーズでのみ、SAFE公開演出用として罠位置を両者へ送ります。
- 得点、感電回数、使用済みイス、勝敗はサーバー権威型です。
- 再接続猶予は180秒です。

## 注意

- Render無料環境ではデプロイやインスタンス破棄時にローカルスナップショットが消える可能性があります。
- 実績・AI解放・対戦履歴はブラウザのlocalStorageに保存します。ブラウザデータを消すとリセットされます。
- Web Share APIの共有メニューはHTTPSかつ対応ブラウザで利用できます。非対応環境では招待URLをクリップボードへコピーします。
- 番組ロゴ、映像、実際の番組音源は使用していません。ビジュアルは暗雲・雷・メタリック表現を用いたオリジナルのオマージュデザインです。


## v3.4 layout correction
- iPhone Safariで中央に密集していた12脚をJS座標計算へ変更。
- 全12脚を真円上へ配置し、それぞれ中心方向を向くよう修正。
- HOMEの巨大な空白を削減し、主要操作を上方へ再配置。
- SOLOのAI画像と文字の重なりを解消。
- SAFE/罠公開オーバーレイをVisual Viewport中央へ固定。
- 結果情報の重複を削減し、SAFE→罠公開の順序を明確化。
- iPhone 15クラスの文字サイズを再調整。


## v3.4 layout correction
- Game screen uses explicit grid areas and a single context row for AI/challenge banners.
- Fixes challenge arena being pushed off-screen and online waiting arena/action rows jumping upward.
- Removes arena translate hacks.
- Adds client session-handshake gate and automatic resume request.
- Re-centers overlays against VisualViewport without double safe-area padding.

- SAFEで取得済みのイスは通常盤面から完全に消え、罠公開時だけ安全席として一時表示されます。
