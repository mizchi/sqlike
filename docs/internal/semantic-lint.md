# jev-lint の導入とリファクタ

2026-11-19。`jev-lint@0.8.0` を開発依存へ固定し、[設定](../../.jev-lint.yaml)で26ルールを有効にした。[公式の導入手順](https://github.com/mizchi/jev-lint/blob/main/README.md)に従い、配布済みの cutoff と severity を使う。TypeScript / MoonBit の型検査、SQLite 差分テスト、永続化の障害テストは引き続き別に実行する。

## 対象とルール

`src`、`adapters`、`scripts`、`tests`、`e2e`、`npm`、`packages`、`examples` と root の `package.json` が対象。生成された baseline / AOT の `engine.mbt`、`*.generated.*`、`*_generated.mbt` と fixture は除外する。MoonBit の検査は元の `packages/sqlike/src/full` と Litestream の実装に対して行う。計測記録と内部設計文書は対象に含めない。

| 有効なルール群 | このリポジトリで見る契約 |
| --- | --- |
| 関数名・メソッド名と処理 | SQL実行、checkpoint、ACK、prune の操作名と実際の副作用 |
| 宣言・ブロックのコメント、doc の失敗条件 | CAS、原子的公開、再読込、サイズ上限の説明と実装 |
| catch、エラーメッセージ | 保存・送信の失敗が呼び出し元へ伝わるか、拒否理由が条件と一致するか |
| 型・trait の名前 | ストレージや同期 API の名前と、提供するメンバーの対応 |
| テスト名、mock、snapshot、失敗経路 | テストが名前で約束した振る舞いを検証しているか |
| TypeScript の safe / idempotent 名 | フォールバックや再実行の約束と処理 |
| npm script 名 | `package.json` の名前と実行コマンド |

MoonBit の safe / idempotent 名は全体の dry-run でマッチがなかったため保留した。module / variable の命名や pure 名、ログの規約は、個別の慣習を確認してから追加する。sqlc 用の `-- name:` SQL ルールは JSON catalog を検査できないため有効化していない。文章の編集規則と Git hook は今回導入していない。

失敗経路のルールは関連テストの探索がヒューリスティックで、特に MoonBit の実装を TypeScript から検証する組み合わせを拾えない場合がある。`unpaired` は未検証を意味し、テストが存在しないという判定ではない。既存のカバレッジや SQLite 差分の保証へ置き換えない。

## 実行

Node 24+、pnpm、Git と C コンパイラーが必要。`just lint-setup` は [tree-sitter-moonbit の固定 revision](https://github.com/moonbitlang/tree-sitter-moonbit/tree/dd8c9ebab659cf5cd039342704e42aca88b2b34a) を取得し、macOS / Linux 向けのパーサーを `.jev-lint/parsers/moonbit.so` にビルドする。tree-sitter CLI のインストールは不要。取得・ビルドに失敗した場合は終了コードを伝播する。パーサーと jev-lint は開発用で、npm の DB ランタイムへ同梱しない。

```sh
just lint-check      # APIキー不要。設定・対象範囲・実際のマッチを検査
just lint-plan       # APIキー不要。全体の対象数と料金の見積もり
just lint adapters src  # 設定済みルールで範囲を絞ってモデル判定
just lint-review     # 未コミット差分。必要なら --base <ref> / --staged
```

モデル判定には `TYPESAFE_API_KEY` または `TYPESAFEAI_API_KEY` をプロセス環境へ設定する。キーは設定ファイルへ書かない。今回のローカル実行では `source ~/.profile` で読み込んだ。`jev-lint doctor` はキー・ast-grep・MoonBitパーサーが揃った `complete` となった。コードの対象箇所は TypeSafe API に送信される。

`just lint` と `just lint-review` は指摘を表示し、`generated/jev-lint/check.json` / `review.json` に回答を記録する。現段階の指摘は advisory とし、`--fail-on error` を使う。設定エラー・通信失敗・回答欠落は成功扱いにしない。配布済み閾値の変更や、今回のコードに対する精度の保証はしていない。モデルの指摘は該当コードと照合してから修正する。

通常の `just check` / `pnpm check` と、CI の `just ci-typecheck` にはキー不要の `lint-check` を組み込んだ。CI はモデル判定を実行しない。未レビューの回答キャッシュは Git 管理から外し、承認済み baseline として扱わない。

## 今回の変更と検証

`AotCheckpoint` をコントラクト層へ移し、既存の adapter からの import は re-export で維持した。アップロードに必要な `AotLtxUploadSource` / `AotLtxSyncSource` を定義し、`aot-upload.ts` が具体的な `AotDatabase` を型の参照元にしないようにした。DB 実装の `implements` と型検査で対応を確認する。

`AotDatabase` と `SqlitePagerClient` の待ち行列は、呼び出し元へ元の結果・例外を返す一方、直列化のための末尾 Promise は両方の経路で `void` に変換する。従来の `catch` だけの末尾は正常完了時の SQLite イメージや page commit の返り値を、次の操作まで保持していた。この参照を外した。モデル判定後の横断確認で、binary DDL実行器とLTX gatewayの末尾Promiseも同様に修正した。SQL・保存・再送の順序は既存の回帰テストで確認する。

設定のない状態で専用の3テストが失敗する Red を確認した後、設定・パーサーを導入して Green にした。テストは実際の CLI を使い、ルール読込、生成物の除外、手書き実装の対象化、MoonBit の関数と catch、TypeScript のテスト、npm script にマッチがあることを確認する。

導入時の全体 dry-run は約8,500件の対象、約1,240リクエスト、約 $0.43 の見積もりだった。その後、プロファイルからキーを読み込んで以下のモデル判定を実施した。導入時の型分離とキューの変更はコードの読解に基づき、モデル判定後の変更とは区別する。

## モデル判定の初回レビュー

モデルは `jev-1.14.0`。初回の全体判定、変更した15ファイルの3回再判定、追加キュー修正2ファイルの3回再判定を記録した。通信エラー・回答欠落・context劣化は0件。以下の額はツールの算出値で、請求明細ではない。

| 実行 | 対象 | 繰返回数 | 指摘候補 | API calls | 算出額 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 初回全体 | 8,518 | 1 | 530 | 1,237 | $0.373734 |
| 変更した15ファイル | 329 | 3 | 21 | 108 | $0.040776 |
| 追加キュー修正2ファイル | 88 | 3 | 7 | 24 | $0.011985 |

範囲と対象数が異なるため、530から21への改善率ではない。再判定は修正したファイルを検査するもので、全体がcleanになったという意味でもない。cutoff / severityは変更せず、指摘を消すための suppression も追加していない。

| 照合して採用した内容 | 変更と検証 |
| --- | --- |
| 非通常ファイルも「LTX file exceeds 64 MiB」と返す | Nodeのファイル読込を`readReplicaLtx`へ分離し、通常ファイル判定と上限判定を分けた。実ファイル・directory・疎な上限超過ファイル・不正ID・ENOENTを検査。directoryに対する誤った理由をRedで再現して修正した |
| ファイル名なしPUTにも「GET or PUT」と返す | catalogとfileの405メッセージを分けた。HTTP status / codeは維持し、PUT / POST / DELETEの説明とgateway状態が不変であることを検査。ファイル名不足を説明しない状態のRedを確認した |
| Drizzleのprivate helperが検証・拒否の役割を表していない | `checkedNumber`、`assertSynchronousCallback`、`requireSynchronousResult`へ改名。数値範囲と同期transactionの既存テストを実行した |
| 古い説明・他の宣言へ付いた説明 | primary indexを使う`candidate_rows`の説明、float変換とhelperの説明、image検証の説明位置、SearchHit / SearchIndex、DDL tokenizer、RPC command、Nodeのmigration関数を整理した |
| MoonBitのframe encoderが空bytesで失敗を返す | 既存のFFI ABIを維持し、空bytesが失敗sentinelでhostが例外へ変換することを明記した。`src/protocol.ts`の変換処理と既存protocolテストを確認した |

未採用の例は、MoonBitのJSON `error`を返すcatch、空bytesのFFI sentinel、IndexedDBの`tx.abort()`から`onabort`のrejectへ伝わるcatch、SQLite互換の数値overflow / underflow変換、テスト用in-memory storeの空`close()`。それぞれエラーの通知や互換動作が別の形で成立しており、判定だけでthrowへ置き換えない。

一方、`tests-cover-failure-paths`の候補は、関連テストのexcerptが不十分な場合と、実際に未到達の分岐がある場合の両方を含む。`validate_store_rows`のように検証と派生値の回復を同時に行う関数の命名候補も含め、残余は未承認として個別にレビューする。530候補すべての精度を評価したわけではない。

回答と機械可読レポートはGit管理外の`generated/jev-lint/initial.json` / `initial-report.json`、`followup-3.json` / `followup-3-report.json`に保存した。元の回答は修正前のsourceを対象としており、再生結果を現在のsourceに対する新しい判定と扱わない。回答recordのSHA-256は初回`d8a1c6d8e0abbf320b057173b96081fee0678ca1ae12c3fe9a9e0590821f8c07`、再判定`571ae4bcb6a68ff05587ef24b86f21c3fa59bc575578047d457eb4276dfdf293`。

追加キュー修正の回答は`generated/jev-lint/queues-3.json` / `queues-3-report.json`。回答recordのSHA-256は`1f89df0560976a6e3f3fb17d82090beff1ea07e64ab629e30708e3d05464b344`。範囲が重なるため各runの候補件数を合計しない。

MoonBitのコメント移動もsource hashを変える。既存のサイズ・速度・build graphの測定記録を今回の実測に見せるhash更新は行っていない。次回の測定・公開前の再検証はV03で管理する。

`LITESTREAM_BIN=/tmp/browser-litestream-tools/litestream just check` が通過した。専用 lint 検証3件、MoonBit は JS / Wasm 各93件、Node 568件、Chromium 73件に加え、型検査と独立した npm consumer を確認した。SQLite 出力監査は各経路で508 probeが一致し、値の不一致0件、原子的拒否230件。全体検証後の追加キュー修正は関連Node 20件・型検査・Chromium 4件（Node / DOへのLTX uploadと本家復元、binary DDLの再読込）で確認した。追加E2Eの初回は`LITESTREAM_BIN`を渡し忘れて復元前提のassertが失敗し、指定した再実行で4件通過した。未対応・未検証の機能は残るため、SQLite 全機能の互換性を意味しない。Linux CI での実行結果は別途確認する。
