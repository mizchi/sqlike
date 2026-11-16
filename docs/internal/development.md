# 開発・検証の記録

MoonBit製SQLiteサブセット `mizchi/sqlike` と、DBエンジンに依存しない同期モジュール `mizchi/litestream` のモノレポ。公開リポジトリは [mizchi/sqlike](https://github.com/mizchi/sqlike)、ライセンスは [MIT](../../LICENSE)。

[npm配布](npm-release.md): `@mizchi/sqlike` / `@mizchi/litestream` の独立した配布物を作成する。`just npm-check`はtarballからの別環境install、Node / Chromium、型、IndexedDB、Wasm GC、Drizzleを検証する。ルートのデモはprivateのまま維持する。

[現在の対応範囲・最適化と改善台帳](status-and-improvement-plan.md): SQL / 保存 / 同期 / adapterの制約、実施済みの最適化、計測の有効範囲を整理した。今後は台帳IDと完了条件に沿って改善する。

[固定DDL＋prepared statementのバイナリ初期化](predefined-binary.md): ビルド時にschemaとnamed statementを別のバイナリへ変換し、`DefinedDatabase.open()`から実行する。実行用entryにはDDLパーサ・ALTER・schema / ASTのJSON復元を含めない。snapshot / journalは行データだけを保存し、IndexedDBのstrict commit・古いwriterの拒否・オフライン再開を検証した。notesの定義は314 B＋495 B。SQLite出力用layoutとexporterは任意で読み込む。`just defined-check`で再検証できる。

[必要機能だけのバイナリ実行](predefined-binary.md#必要機能だけを含むビルド): SQL JSON・日時・windowは独立したビルド時オプション。`just sqlike-runtime examples/profiles/notes-defined.json generated/notes-defined`で3機能を除いた構成を生成し、`createDefinedDatabase(runtime)`へ渡せる。必要機能を使う定義は読み込み時に検査する。`just optional-functions-check` / `just measure-optional-functions`で検証・計測する。

[JSの追加圧縮](minification.md): OxcのESライブラリ形式と最終配信形式、Terserの追加パス・内部プロパティ短縮を比較した。`just probe-minification`で再実行できる。選択ランタイムのJSは既定でOxc minify済み。主キー索引だけのコアは81.09 KiB（Brotli）で、公開APIと後続のtree shakingを維持する。Terserは比較試験に留める。

[JSON境界の評価](json-abi.md): `mizchi/x/json`を隔離試験し、bind parseの速度・ランタイム容量・精度と文字の拒否条件を比較した。`just probe-json-facade ../x`で再実行できる。一括置換は採用せず、Jsonを作り直さない型付きABIを改善対象にする。

[Drizzle adapterとmigration](drizzle.md): INSERT / UPDATE / DELETEのRETURNING、UPSERT、JOIN、型変換、nested transactionに対応。Kit生成6本＋custom 2本を本家SQLite・SQLike JS / Wasm・SQLite WASM・実DOで検証し、IndexedDB保存からのオフライン再開も確認する。Drizzleは任意entryで、既定のデモ・liteには含めない。`just drizzle-check`で再検証する。Kit自体の式index生成の不具合と、未対応のrelational query / AOT専用driverは文書に分けて記録した。

[P0の実施結果](p0-results.md): 再計測・324生成差分・U01〜U09の[受入プロファイル](release-acceptance.md)を追加し、列名変更の不具合も修正した。`just p0-measure`で逐次計測し、`LITESTREAM_BIN=/path/to/litestream just p0-check`で全回帰・差分・成果物の鮮度を検査する。v0.1.0の受入範囲として採用する。

[P01のAOT改善](p01-aot-results.md): 検証済みの列metadata・射影位置を再利用し、bind / 結果変換の配列生成を削減した。1,000行のPK検索はJS 4.97 → 2.15µs、Wasm 4.79 → 1.56µs。既存ABI・Programの形式とバイト列を維持し、SQLite差分・保存復旧・配信サイズも再確認した。

[S01の列差分](column-delta.md): 通常の永続ログを`sqlike-flush@2`の変更列patchへ変更し、旧v1ログもreplayする。4 KiB列付きの16行更新は68,301 → 1,501 B、checkpoint込み平均はTEXT 1.94 → 1.39ms / BLOB 3.20 → 1.97ms。strict ACK・trigger / FK・rollback・再開を検査した。全量checkpointと全行のメモリ保持は残る。

[P02の行ページ](row-store.md): メモリ内の行を64行単位のCOWへ変更し、主キー索引もclone間で共有する。1,000行のclone＋実UPDATEはJS 117.83 → 3.75µs / Wasm 26.35 → 2.93µs、32更新versionの追加heapは約3,710 → 58 KiB / 2,930 → 50 KiB。1,000行×64 B TEXTのIDBの1行更新は0.327 → 0.196ms。保存形式を維持し、AOTアプリの転送量は+4,078 B。全量checkpoint・全行保持・削除後の定期圧縮の費用は残る。

[R02のAOT LTX送信](aot-ltx-upload.md): `/lite/`からNode relayまたはDOの専用gatewayへ送信できる。履歴の所有者・送信先・Programを固定し、TXIDとhash付きACKで冪等に受理する。オフライン生成→再起動→ACK消失→再送→サーバーから取得したLTXの本家復元を両経路で検証した。DOにはLTXをBLOBとして保存し、通常のSQL同期とは別の一つの物理履歴として扱う。

[C02のDO対応時の記録](do-consumer-sql.md): CTE付きSELECT / DML、列ベースのRETURNING、index / table metadataを追加した。その後のDrizzle対応でRETURNINGの決定的な式・bindと、排他migrationでのtrigger導入を拡張した。書込は一度だけ実行し、非決定的な関数・subqueryは変更前に拒否する。集約代表行などはC02の残項目として維持する。

[出力互換の契約](sqlite-output-compatibility.md): 未対応は明示拒否し、成功した値・型を別の意味へ変換しない。`just check`には、未対応の拒否を許容しつつ出力差・誤受理・非atomicな拒否を落とす`sqlite-output-check`を含む。

現在のバージョンは **0.1.0**。[リリースノート](../releases/v0.1.0.md)と[対応範囲・リリース条件](roadmap-0.1.0.md)を参照。一般的なブラウザアプリの利用シナリオを必須プロファイルで検証した。[index・trigger](sqlike-index-trigger.md)に加え、[SQLトランザクション・CAST・JSON・日時・window・再帰CTE・移行と任意の全文検索](sqlike-app-features.md)を追加し、永続化・SQL同期まで検証した。SQLite 全機能互換とは別の到達点として管理する。

[機能選択APIと追加機能](sqlike-feature-profiles.md): RIGHT/FULL JOIN・STRICT・主キー専用索引を追加。trigger/FK付きbinary同期は任意の抑制wrapperで有効にする。JS/Wasmはビルド時に必要な機能だけ選択し、AOTはSQLパーサを含めずに生成できる。

[SQLite差分の修正と性能改善](sqlite-differential-findings.md): 数値変換・STRICT、NOCASE＋NUL、JOIN、SUM、JSON、rowid、FKなど12項目を修正。566入力×Node/ChromiumのJS・Wasm・AOTで差分ゼロを確認し、`just differential-audit`は成功する。集約・LIMIT・更新も改善した。全SQLite機能の互換性は未達。

MoonBit の JS backend を使った、ブラウザ SQLite のオフライン同期 PoC。SQLite WASM / OPFS と、MoonBit で新規実装した SQL engine / IndexedDB を Worker 内で動かし、データと outbox を同じトランザクションに保存する。

[事前コンパイル実行と LTX 生成](aot-ltx-plan.md)を追加した。`just build-lite` で `/lite/` を開くと、SQL parser を含まない MoonBit ランタイムで保存・オフライン再読込・SQLite ページと LTX の生成を試せる。API は指定の `moonbit-community/sqlite3.mbt` を参考にした型付き `Connection` / `Statement`。LTX は本家 Litestream で復元して検証する。[配信量と速度の比較](aot-performance.md)も記録する。

[P0でのバンドル再計測](p0-results.md): 初回転送はBrotliでSQLike AOT **106.98 KiB**、SQL文字列版SQLike **163.77 KiB**、SQLite WASM **474.83 KiB**、Turso **3.63 MiB**。任意の全文検索と実験的LSMは含めない。[以前の計測記録](runtime-size.md)と[Web標準APIによる削減試作](web-platform-size.md)は分けて残す。

[JS / Wasm GC の速度比較](wasm-performance.md): Chromium では LTX 生成が約1.8倍、適用が約1.3倍速い。最適化前の AOT 測定では検索・更新は JS と同程度かやや遅かった。SQL 実行の最新値は下の改善計画に記録する。`just wasm-bench` で Node / Chromium の両方を再計測できる。

[SQLite WASM との速度差と最適化候補](sqlite-performance.md): 主キー・範囲検索、LIMIT、集計、更新を行数を変えて比較し、CPU profile から改善対象を記録した。`just sqlite-bench` で再計測できる。

[改善計画と実施結果](sqlike-optimization-plan.md): 名前解決・候補限定・二次索引・増分更新・全体mapの除去に続き、[IndexedDBの差分保存](indexeddb-persistence.md)を実装した。P0再計測の1,000行×64 B・durableな1行更新は全量保存 **1.713 ms**、行差分 **0.332 ms**、SQLiteページ差分 **5.727 ms**。[現在の計測条件とメモリ](p0-results.md)を参照。保存契約とfactoryを分離し、別のインフラ実装へ差し替えられる。SQLikeのLTX画像キャッシュもIndexedDBに保存する。

[MoonBit 製 SQL エンジン](moon-sql.md): `engine=sqlike`。SQL parser・評価・制約・行ストア・SQLite Session 差分生成を新規実装し、IndexedDB に永続化する。SQLite ファイルの読取と `backend=ltx` にも対応する。SQL / LTX とも JS FFI を含まず JS / Wasm GC で動き、42ケース・842ステップを照合している。SQLite 全機能互換は未達で、既定の engine は `sqlite`。`just diff-moon` で再検証できる。

[IndexedDB と互換性の評価](indexeddb-compatibility.md)には保存方式と検証範囲の比較を記載している。

[MoonBit LSM 実験](lsm-experiment.md)は**実験専用で、デフォルトには採用しない**。SQLike / AOT は既存の行ジャーナル方式を維持する。LSM のコード・生成物は通常版・lite版・Worker の配信バンドルに含めず、上記のバンドルサイズにも合算しない。混入時は production build を失敗させる。`just lsm-bench` で独立した ordered KV の更新・検索・復旧・保持メモリを比較し、LSM 単体のサイズは実験レポートにのみ記録する。SQL / LTX への接続と物理 GC は未実装。

[本家 SQLite との直接差分テスト](sqlite-conformance.md): 上流 `select1.test` の全1,000件、生成式7,776件、REAL 文字列化528件、失敗・rollback 11件を JS / Wasm GC / Chromium で照合する。元の期待値・MD5 と型付き結果を検査し、失敗する SQL は除外しない。`just conformance` で実行できる。

[全機能の互換性監査](sqlite-feature-audit.md): 生成差分も含む1,618項目を点検し、432 probe一致・270 atomic拒否・出力不一致0。公開C APIの欠如や未検証も残る。`just sqlite-output-check`は通過するが、全機能を要求する`just sqlite-audit`は現状ではexit 1を返す。

[バックエンドの共通契約と機能差](backend-contract.md)、[SQLike の互換性・速度を維持する検証](sqlike-development.md)を定義している。ブラウザの正式な指定は `engine=sqlike`。旧 `engine=moonbit` も同じ実装への別名として使える。

## 試せる構成

| backend | 正本 | 通信 | 下り |
| --- | --- | --- | --- |
| `node` | Node 24 の SQLite | HTTP | 論理 snapshot |
| `do` | SQLite-backed Durable Object | HTTP | 論理 snapshot |
| `peer` | ホストブラウザの DB（SQLite / Turso / MoonBit） | Node の WebSocket リレー | 論理 snapshot |
| `peer-do` | ホストブラウザの DB（SQLite / Turso / MoonBit） | DO の WebSocket リレー | 論理 snapshot |
| `litestream` | Node の SQLite | HTTP + 本物の Litestream | LTX から復元した DB の論理 snapshot |
| `ltx` | Node の SQLite | HTTP + 本物の Litestream | 元のLTXをブラウザでページ適用し、選択エンジンの画像ストアへ保存 |

リレーは opaque なバイナリをホストとクライアント間で転送する。ブラウザのホストを一つ選び、その DB を正本にする。WebRTC、ホスト選出、ホストの自動引き継ぎは未実装。

## 起動

Node 24+、pnpm、MoonBit CLI、just が必要。検証環境は Node 24.22.2 / moon 0.1.20261104。

```sh
just install
just build

# 別々のターミナルで起動
just relay                 # 127.0.0.1:19878
just do                    # 127.0.0.1:19879、ローカル workerd
pnpm exec vite preview     # 127.0.0.1:14173
```

通常の開発には `just dev` も使える。オフライン再読み込みは Service Worker を生成する production build / preview で試す。

二つのブラウザ、または別プロフィールで次を開く。

```text
http://127.0.0.1:14173/?backend=node&room=demo&client=a
http://127.0.0.1:14173/?backend=node&room=demo&client=b
```

DO は `backend=do`。ブラウザを正本にする場合は、まずホストを開く。

```text
http://127.0.0.1:14173/?backend=peer&room=demo&client=host&role=host
http://127.0.0.1:14173/?backend=peer&room=demo&client=a
http://127.0.0.1:14173/?backend=peer&room=demo&client=b
```

`peer-do` も同じ操作。ホストのタブは開いたままにする。同じ origin で複数タブを使うときは異なる `client` を指定する。SAH pool の各 OPFS ディレクトリを開く Worker は一つに限定している。

「同期」で初期状態を取得し、ネットワークを切って SQL をローカル実行する。再読み込み後も未送信の更新が残る。再接続後の「同期」で送信・確定する。同期はこの PoC では明示的に呼び出す。

## MoonBit 製 SQL エンジンを使う

```text
http://127.0.0.1:14173/?backend=node&engine=sqlike&room=moon-demo&client=a
http://127.0.0.1:14173/?backend=ltx&engine=sqlike&room=pure-ltx&client=a
http://127.0.0.1:14173/?backend=peer-do&engine=sqlike&room=moon-peer&client=host&role=host
```

SQL と native Session 形式の差分に対応する。データ・outbox・receipt の変更を、世代CAS付きのIndexedDBトランザクションで原子的に保存する。通常は変更行ジャーナル、定期checkpointでは全量画像を使う。保存Workerとの共有応答領域は4 KiB。COOP / COEPが必要。`node` / `do` / `peer` / `peer-do`に加え、`ltx`もSQLite WASMを使わず同期・オフライン再読込をテストしている。LTX展開後のSQLiteファイルをpure MoonBitで読み、SQLikeでは確定イメージのキャッシュも作業状態・outboxもIndexedDBに保存する。AOT経路にはSQLiteページwriterがある。WAL writerと大規模DB向けの永続検索B-treeは未実装。[対応範囲と検証方法](moon-sql.md)を参照。

## Turso WASM を使う

[`@tursodatabase/database-wasm`](https://github.com/tursodatabase/turso/tree/main/bindings/javascript/packages/wasm) **0.8.3** のアダプターも実装している。`backend` は通信先、`engine` はブラウザ内の DB を選ぶ。既定は `engine=sqlite`。Turso は SQLite 互換の別エンジンなので、すべての SQL・拡張・物理複製 API の互換性を前提にしない。

```text
# ブラウザのローカル DB は Turso、正本は Node SQLite
http://127.0.0.1:14173/?backend=node&engine=turso&room=turso-demo&client=a

# Turso を P2P の正本にする。クライアントの engine は個別に選べる
http://127.0.0.1:14173/?backend=peer&engine=turso&room=turso-peer&client=host&role=host
http://127.0.0.1:14173/?backend=peer&engine=sqlite&room=turso-peer&client=a
```

`backend=do` と `peer-do` でも利用できる。Node の Litestream restore gateway を使う論理 snapshot 経路とも組み合わせられる。Turso のデータと outbox は OPFS の `browser-litestream-turso-<client>.sqlite` に同じトランザクションで保存する。通常の SQLite WASM のディレクトリとは分かれており、`engine` の切り替えは既存ローカル DB の変換を行わない。

| 機能 | Turso アダプター |
| --- | --- |
| SQL batch の送信・受信 | 対応。実行結果の照合、ロールバック、MoonBit の解決ポリシーも共通 |
| SQLite changeset の受信 | ホストとして対応。MoonBit で old value の検査と SQL への変換を行う |
| SQLite changeset の生成 | 未対応。Session capture API を公開していないため、変更前にエラーにする。UI / `execute()` の既定は SQL |
| LTX の直接適用 | 未対応。`engine=turso&backend=ltx` は初期化前にエラーにする |

Turso の公開 API は非同期なので、DB 接続を専用の Worker に置き、同期エンジンの Worker と SharedArrayBuffer で通信する。メイン画面はブロックしない。接続は一つの呼び出し元が直列に使い、BEGIN から COMMIT / ROLLBACK まで他の要求を挟まない。RPC が 10 秒で完了しない場合や rollback を確認できない場合は、接続を閉じて再読み込みを要求する。未確定の結果をアプリの解決ポリシーに渡さない。

SharedArrayBuffer のため COOP / COEP が必要。Vite dev / preview には設定済みで、別のホスティングでも次のレスポンスヘッダーを設定する。

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Turso の `safeIntegers(true)` と型付き RPC で int64・BLOB を保持する。独自の `__turso_` 内部テーブルは snapshot・実行結果・changeset の対象から除外し、アプリからのアクセスも禁止する。スキーマ署名は DDL のトークン列を比較し、整形・コメント・引用されていない ASCII の大文字小文字の差を揃える。リテラルと引用された識別子の内容は保持し、スキーマ世代の検査も続ける。

現在の bundle は約 16 MB、アダプターの共有応答領域は最大 64 MiB。ドライバー自身も共有 Wasm メモリを使うため、既存の SQLite WASM と同じメモリ使用量にはならない。性能比較と大規模 DB の最適化は未実施。

## SQL とバイナリの比較

両経路とも MoonBit の `BLS1` バイナリエンベロープを使う。payload が異なる。

| モード | payload | 古い revision | 用途・制約 |
| --- | --- | --- | --- |
| SQL batch | SQL + 型付き bind 値の UTF-8 JSON | 保留してローカルに保持 | 汎用 DML、DDL。正本で再評価した変更内容・変更件数・返り値・スキーマをローカルの実行結果と照合 |
| Binary changeset | SQLite Session Extension のネイティブバイナリ | old value が一致する更新を受理 | 通常テーブル、宣言済みの非 NULL 主キーが必要。trigger / FKは任意の[materialized適用API](sqlike-feature-profiles.md)で対応。生成列・仮想テーブルは対象外 |

SQL の `random()`、現在時刻、採番などでローカルと正本の結果が変わった場合、正本の試行をロールバックして操作を保留する。生成したキーを使う後続の UPDATE が 0 件になっても成功扱いにはしない。UUID や時刻をクライアントで確定して bind するか、対応範囲内なら実際の値を記録する changeset を使う。基準 revision の不一致や実行結果の不一致を扱うアプリ固有の方法は、後述のポリシーで記述できる。

SQLite Session の changeset、独自 BLS1 エンベロープ、Litestream LTX は別の形式。DO と Turso では Session Extension を呼べないため、MoonBit が changeset をデコードし、old value の検査と SQL 書き込みの計画を生成する。各 DB のトランザクション内で適用する。Node と通常の SQLite WASM のホストはネイティブ changeset API を使う。

DO の数値 bind / 結果 API で正確に扱えない int64 はエラーにする。Node と changeset codec は符号付き int64 を文字列で損失なく受け渡す。

## 同期の保証

- 更新と outbox への追加は同一 DB トランザクション。MoonBit engine は一つの IndexedDB transaction で完全なイメージを公開。
- 正本ではデータ更新と操作 ID・元フレーム・適用結果の receipt を同一トランザクションで確定。
- 同じ ID と同じバイト列の再送は重複として返す。ID の使い回しで内容が異なる場合は拒否。
- 送信済み操作も、ACK 以上の revision の snapshot をローカルに取り込むまで outbox から消さない。ACK 消失、ダウンロード失敗、再起動後の再送に対応する。
- DB の identity、スキーマの世代と署名を SQL / changeset の両方で検査する。同じ列数・主キー構成の別テーブルや、同じ DDL で作り直したテーブルへ古い changeset を適用しない。
- 既定では競合・曖昧な対象を保留し、ローカルのデータと outbox を維持して編集を止める。利用側のポリシーで保留・拒否・明示的な置き換えを選べる。マージ UI や CRDT は未実装。
- snapshot はローカルのトランザクション内で置き換える。ページ差分をローカル更新済み DB へ直接上書きしない。

操作フレームは guard を含めた payload 1 MiB まで。`BLS1` 内の `BGC2` guard に DB の identity・スキーマ世代・署名・ポリシー名・intent・件数条件・SQL の実行結果のハッシュを入れる。guard のない旧形式の未確定操作は拒否し、明示的な置き換えを必要とする。旧形式でも確定済みの操作 ID と同じバイト列の再送は先に重複排除する。

`ltx` は初回に完全な LTX snapshot を受け取り、次回から保存済み TXID を基準に必要な LTX 差分を取得する。他の backend の下りは論理 snapshot。リレーの大きな返答は 64 KiB のチャンクに分割し、総サイズ・offset・SHA-256 を検証してから最大 64 MiB まで組み立てる。1 MiB を超える snapshot も Node / DO の両リレーを通る。

SQL は bind 対応の一文を配列で受け取る。トランザクション制御、PRAGMA、ATTACH、VACUUM、拡張ロード、内部の `_bls_` / `_litestream_` / `sqlite_` / `__turso_` 名前空間へのアクセスを拒否する。ネットワークから受け取る SQL lexer は、セミコロンを内部に持つ CREATE TRIGGER などを引き続き拒否する。trigger は AOT schema またはアプリ所有の trusted `SyncEngine.migrate()` から導入する。デモ UI は `notes` テーブルを表示するが、API の batch は他のテーブルにも使える。

## API

ブラウザのコンソールからも比較できる。

```js
// 初回は DB identity とスキーマの契約を取得する。以降はオフラインで編集できる。
await syncDemo.sync();
await syncDemo.execute(
  'INSERT INTO notes(id,title,score) VALUES (?,?,?)',
  ['a', 'offline', 42n],
  'changeset', // または 'sql'
);
await syncDemo.query('SELECT * FROM notes');
await syncDemo.sync();
await syncDemo.state();
```

サーバーは `GET /api/:room/snapshot` と `POST /api/:room/push`。リレーは `/relay/:room`。DO と Node は同じ契約を実装する。接続は開発用で認証・認可を実装していない。公開サービスへの deploy は行っていない。

## 適用条件と利用側のポリシー

コントラクトは [`src/safety-contract.ts`](../../src/safety-contract.ts)。実装を組み込む側が `SyncEngine` の `policies` に名前付きのポリシーを登録する。ブラウザからはバージョン付きの名前と JSON の `intent` を渡し、実行コードは送らない。デモの登録箇所は [`src/application.ts`](../../src/application.ts) で、Node、DO、ブラウザのホストが同じ設定を使う。

| フック | 実行時点 | 返せる判断 |
| --- | --- | --- |
| `before(context, read)` | 正本で試行する前。解決案の適用前にも再実行 | `apply` / `defer` / `reject` |
| `onAmbiguous(context, read)` | スキーマ不一致、stale SQL、old value 競合、件数・実行結果の不一致をロールバックした後 | `defer` / `reject` / `resolve` |
| `after(context, read)` | 元の操作または解決案の実行後、コミットする前 | `apply` / `defer` / `reject` |

`context` には元の操作、intent、ローカルと正本のスキーマ・revision、実行結果のハッシュ、失敗理由を渡す。`read` はそのトランザクション内の正本へ SELECT だけを実行する。フックは同期関数に限定し、context は再帰的に freeze する。例外・Promise・不正な戻り値・未知のポリシー名は拒否し、データを確定しない。フックは複数回呼ばれ得るため、副作用を持たせず、必要な外部情報は先に intent 等へ固定する。

`resolve` は理由、**置き換える SQL 文**、その対象件数の条件を返す。古いバイナリを無条件に適用する指定はない。解決案もトランザクション内で件数条件と `after` を検査し、操作 ID に対して一度だけ確定する。DB identity の不一致、通信・破損・リソース上限の問題はこのフックで上書きできない。

一意性は、アプリが対象を選ぶ SELECT と期待件数で記述する。SQL 文の意図をエンジンが自動推測することはない。例えば同じ title のメモが複数あり、利用者が `b` を選んだケースは次のように送れる。

```js
await syncDemo.execute("UPDATE notes SET score=7 WHERE title='same'", [], 'sql', {
  policy: 'select-note@1',
  intent: { id: 'b', score: 7 },
  assertions: [{
    name: 'target',
    query: { sql: "SELECT id FROM notes WHERE title='same'", params: [] },
    exactly: 1,
  }],
});
await syncDemo.sync();
await syncDemo.receipts(); // outcome: 'applied' または 'resolved'、解決理由・返り値
```

デモの `select-note@1` は [`packages/litestream/src/example_policy.mbt`](../../packages/litestream/src/example_policy.mbt) に MoonBit で記述している。intent の範囲を検査し、一意でなければ選択済み主キーの存在を再確認して `WHERE id=?` の SQL に置き換え、適用後の score も検証する。選択した行がなければ保留する。この関数を編集するか、別名の `ApplyPolicy` を登録して用途ごとに実装する。呼び出し側がポリシーを選べるため、認可など必須の検査はホストの認証・認可層で強制する必要がある。

クライアント側で利用者に選択・マージしてもらう場合は `ClientOptions.onIssue` を使う。返り値は `defer` / `reject` / `replace`。画面で保留した後に `OfflineClient.resolvePending()`、デモでは `syncDemo.resolve()` から同じ判断を渡せる。

```js
await syncDemo.resolve({
  action: 'replace',
  reason: '生成したキーを確定し、後続操作も組み直した',
  operations: [{
    mode: 'sql',
    statements: [{ sql: "INSERT INTO notes(id,title) VALUES('fixed','stable')", params: [] }],
  }],
});
await syncDemo.sync();
await syncDemo.resolutions(); // 元の outbox、理由、新しい操作 ID の監査記録
```

`replace` は正本を再取得し、**未確定の操作列全体**を新しい ID の操作列に置き換える。依存する後続操作も呼び出し側で指定する。確定済みの前半は再実行せず、receipt を残す。空の `operations` は未確定の操作列の破棄を表す。`defer` と `reject` はデータや outbox を消さない。

置き換えを許可するのは、正本がトランザクションを拒否したと確認できた場合だけ。タイムアウト、ACK 消失、壊れた ACK ではコミットしたか不明なので、まず同じ ID・同じバイト列を再送して確認する。受理した操作は snapshot の取得に失敗しても `accepted` と receipt を永続化し、次回はダウンロードから再開する。

スキーマ移行は `engine.migrate([statement(...)])` で実行すると、DDL の文字列が同じでも世代を進められる。Node / WASM では SQLite の schema cookie により外部 DDL も検出する。DO は schema cookie を公開しないため、ホストからの移行は必ずこの API を通す。DO の SQL API で直接 DROP / CREATE し、まったく同じ定義に戻した操作は、署名だけでは検出できない。

SQL の実行結果の照合は、現状では各文の前後にアプリの通常テーブルを全走査し、変更行・返り値・変更件数・スキーマをハッシュ化する。PoC の正確性を優先した実装で、大きい DB 向けの差分取得の最適化は未実装。

## 失敗時の扱い

`SyncIssue` は種類、コード、保留／拒否、再試行可能か、正本による拒否を確認できたかを持つ。

| 失敗 | 動作 |
| --- | --- |
| 通信断・ACK 消失・ホスト不在 | 10 秒でタイムアウト。同一操作を既定で最大 3 回試行。未確定状態を維持 |
| old value 競合・stale SQL・件数／実行結果の不一致 | 試行をロールバック。既定は保留。利用側で解決案または選択 UI を実装 |
| スキーマ変更 | 既定は保留。移行先が明確ならポリシーで新しい SQL へ置き換え |
| LTX の転送破損・不正な index／checksum | 確定イメージ・cursor・outbox を維持して停止 |
| 保存済みイメージの欠落・破損、TXID の欠落、replica の再作成 | `onReplicaIssue` で保留・再試行・完全 snapshot からの再構築を選択 |
| DB identity の変更 | 同じクライアントへの取り込みを拒否。別 DB への移行は明示的に行う |
| サイズ上限 | `resource` として停止。リレー返答・HTTP 返答・LTX ファイル・DB イメージは最大 64 MiB |

`ClientOptions.retry` で回数と待ち時間を設定できる。デモは replica の再構築が可能な問題だけ自動 resnapshot を選ぶ。候補の検証と同じ DB identity の確認が終わるまで、古い cursor やローカル変更を消さない。ブラウザのホスト選出・自動引き継ぎは未実装なので、ホスト不在ではそのホストの復帰が必要。

## Litestream を実際に通す

Litestream **v0.5.18** で検証。実行ファイルの絶対パスを指定して Node サーバーを起動する。

```sh
LITESTREAM_BIN=/absolute/path/to/litestream just relay
```

`backend=litestream` でアクセスすると、room ごとに Litestream を起動し、`data/<room>.sqlite` を `data/replicas/<room>/` に複製する。下りは `GET /api/:room/replica`。ゲートウェイが実際の `litestream restore` で一時 DB に復元し、その内容から snapshot を作る。ACK した revision への到達を待つ。

## LTX をブラウザで直接適用する

同じ Node サーバーに対して `backend=ltx` を指定する。

```text
http://127.0.0.1:14173/?backend=ltx&room=direct&client=ltx-a
http://127.0.0.1:14173/?backend=ltx&room=direct&client=ltx-b
http://127.0.0.1:14173/?backend=ltx&engine=sqlike&room=direct&client=moon-a
```

この経路ではサーバーの `restore` や論理 snapshot API を呼ばない。`GET /api/:room/ltx` で format・replica identity・ファイル一覧を取得し、`GET /api/:room/ltx/:level/:filename` で Litestream が生成した元のバイナリを取得する。サーバーは `litestream sync -wait` を barrier にして、ACK 済みの更新が複製先に含まれることを保証する。

MoonBit の reader は `superfly/ltx v0.5.2` の **LTX v3** に対応する。LZ4 block と旧 LZ4 frame の独立 block、CRC64-ISO、ページ index の番号・offset・size、snapshot の完全性、TXID の連続性、DB の拡大・縮小を検証する。チェックサム付きファイルでは適用前後の DB checksum も検証する。区間が重なる圧縮済み LTX は適用後の checksum で検証する。TXID は uint64 のまま保持する。v2 は明示的に拒否する。同じ `LTX1` magic からバージョンを推測しない。

各ダウンロードには catalog の SHA-256 とサイズも照合する。Litestream の `NoChecksum` ファイルでもファイル CRC64 は必須。保存済み DB イメージも SHA-256 で照合し、別の replica identity や別 endpoint へは継ぎ足さない。replica の再作成は、利用側の `onReplicaIssue` が許可した場合だけ完全 snapshot から再構築する。DB 自体の identity が変わった場合は取り込みを拒否する。

確定済みの生のSQLiteイメージは、`engine=sqlite`ではOPFS、`engine=sqlike`ではIndexedDBに保持する。SQLiteの`quick_check`またはMoonBitの物理readerと制約検査を通った候補を先に保存し、flush / strict commitの完了を待つ。その後、候補への参照・ローカルDBの確定状態・revision・outboxの削除を一つのローカルDBトランザクションでコミットする。参照されなかった候補や、コミット後に残った古い画像は次の起動で回収する。

生の確定イメージには WAL mode のヘッダーを保持する。SQLite engine は参照用コピーを SQLite WASM で開き、MoonBit engine はファイルを自身の reader で読む。検証済みの確定状態をローカル作業 DB に取り込む。未同期のローカル変更がある DB へページ差分を直接上書きしない。`syncDemo.state().replica` で TXID、イメージサイズ、直近の取得バイト数・適用ページ数を確認できる。

現在はファイル全体を取得し、DBイメージをメモリ上で構築して選択した画像ストアへ書くため、**LTX 1ファイル・DBイメージともに64 MiB上限**。HTTP Rangeによるページ単位取得と、メモリを一定量に抑える大規模DB対応は未実装。DOのSQLiteはWALファイルを公開しないため、この直接LTX経路の正本はネイティブSQLiteに限定する。DOとブラウザ間リレーの既存経路は引き続き利用できる。

## 構成と検証

ルートの [`moon.work`](../../moon.work) で二つのライブラリとサンプル用の MoonBit モジュールを管理する。`moon build` / `moon test` / `moon check` はルートからワークスペース全体を処理する。

| モジュール | ディレクトリ | パッケージ |
| --- | --- | --- |
| `mizchi/sqlike` | [`packages/sqlike`](../../packages/sqlike/README.md) | SQLite サブセットの本体と `mizchi/sqlike/compiler` |
| `mizchi/litestream` | [`packages/litestream`](../../packages/litestream/README.md) | 同期・LTX の本体 |
| `mizchi/litestream-example` | [`examples/aot`](../../examples/aot/README.md) | SQLike と LTX を組み合わせた AOT 実行サンプル |

SQLike と Litestream は相互に依存せず、どちらも単独で使える。サンプルの `runtime` が両者を組み合わせる。Litestream のホスト側は共通の DB 契約で SQLike / SQLite / Turso を扱う。ワークスペース内の依存はローカルソースで解決する。[MoonBit workspace の仕様](https://docs.moonbitlang.com/en/latest/toolchain/moon/workspace.html)

```sh
just moon-check       # 両モジュールを JS / Wasm GC で検査
just test-sqlike       # SQLike だけを検証
just test-litestream   # Litestream だけを検証
just sqlike-check      # Native SQLite との SQL 差分・エラー・rollback
just sqlike-bench      # 同じ SQL の速度を記録
```

ワークスペースのビルド成果物は `_build/<target>/release/build/mizchi/` 以下に置かれる。TypeScript のアダプター・ブラウザ・検証スクリプトはこの成果物を参照する。

- `packages/sqlike/src/*.mbt`: 独立した SQL parser・評価器・行ストア・制約・Session encoder・SQLite file reader。SQL / LTX とも JS FFI を含まず、JS / Wasm GC を生成。
- `adapters/moon-*.ts`: MoonBit の ABI、トランザクション境界、IndexedDB の保存と世代検査。
- `packages/litestream/src/*.mbt`: バイナリ codec、SQLite changeset decoder、SQL 制約、revision 判定、DO 用の競合検査・適用計画。JS backend の ESM を生成。
- `packages/litestream/src/ltx*.mbt`: LTX / LZ4 / CRC64 reader、ページ適用、圧縮レベルをまたぐ復元計画。
- `src/ltx-transport.ts`, `adapters/opfs-images.ts`: LTX の取得、検証済みイメージの永続化、cursor のトランザクション内更新。
- `src/contract.ts`: プラットフォーム共通の型。
- `src/safety-contract.ts`, `src/safety.ts`, `packages/litestream/src/safety.mbt`: guard、スキーマ世代、SQL 実行結果の照合、適用可否と解決ポリシーの契約。
- `packages/litestream/src/example_policy.mbt`, `src/application.ts`: 利用側が書き換える MoonBit ポリシーと登録設定。
- `src/client.ts`, `src/engine.ts`: 非同期同期処理・トランザクションの実行。
- `adapters/`: SQLite WASM、Node、DO、リレー、Litestream の境界。
- `adapters/turso-database.ts`, `adapters/turso-executor.ts`, `src/database-rpc.ts`: 非同期 Turso ドライバーの接続、OPFS、同期処理との Worker 境界。
- `src/worker.ts`: ブラウザの SQLite を一つの Worker に閉じ込め、要求を直列化。

MoonBit の生成物はビルド時に再生成する。Workers は global scope の乱数生成を禁止するため、生成コードの Map ハッシュ初期化を DO のリクエストコンテキスト内で遅延ロードしている。

```sh
pnpm exec playwright install chromium
# Go 1.26+ と実 Litestream が必要。native 互換性検証を skip しない。
LITESTREAM_BIN=/absolute/path/to/litestream just check

# AOT / SQLite writer / LTX writer と専用ブラウザ検証
just aot-check /absolute/path/to/litestream
```

Playwright は Chromium、実 SQLite WASM / OPFS、ローカル workerd を使う。二つのブラウザの収束、オフライン再読み込み、競合の永続化、SQL 実行結果の不一致、MoonBit での一意な解決、1 MiB 超のリレー返答を確認する。unit test はネイティブ changeset との照合、同形スキーマの置き換え、件数条件、ポリシー失敗時のロールバック、確定状態が不明な操作の保持、ACK 消失・snapshot 失敗・再起動後の重複排除を確認する。

Turso は実際の WASM / OPFS を使い、int64・BLOB、オフライン再読み込み、部分失敗の rollback、Node / DO との SQL 同期・解決ポリシー、Node / DO リレー経由での changeset 受信と競合を確認する。

LTX の golden fixture は実 Litestream v0.5.18 と upstream Go encoder で作成し、公式 restore とバイト単位で照合する。writer の unit test は生成物をその場で upstream Go decoder と実 Litestream に渡すため、Go と `LITESTREAM_BIN` が必要。

```sh
LITESTREAM_BIN=/absolute/path/to/litestream just fixtures
```

破損・途中で切れた転送、欠落した TXID、誤った page index、古いイメージ、cursor のコミット失敗、flush 後のクラッシュを検証する。直接適用の E2E では snapshot / restore gateway へのアクセスを遮断し、破損した LTX を受信しても、確定イメージと outbox が再読み込み後に残ることを確認する。

参考: [SQLite Session](https://sqlite.org/sessionintro.html)、[SQLite WASM persistence](https://sqlite.org/wasm/doc/trunk/persistence.md)、[DO SQLite API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)、[Litestream](https://litestream.io/how-it-works/)。
