# 現在の対応範囲・最適化と改善対象

更新日: 2026-11-17。**0.1.0** の実装・検証を整理した台帳。今後の着手順と完了条件はこのページで管理し、各機能の仕様・実装経緯・測定の全量はリンク先に残す。

0.1.0以後の未リリース変更として、[段階的な互換機能の導入](staged-sqlite-compatibility.md)を開始。軽量な`IS DISTINCT FROM`、`&` / `|` / `~`、`sign()`はcoreへ、JSONの`->` / `->>`は既存の任意機能`sqlJson`へ追加する。後続の不足機能は同ページのチェックリストで管理し、未実装の機能を選択APIへ先行公開しない。

続いて、LIKE ESCAPE・scalar min/max、NULL順序・名前付きSQL bind、索引metadata、FROM subquery・集約FILTER、JSON集約を追加した。大きめの実装は`schemaMetadata` / `aggregateFilter` / `sqlJson`で選択する。[Drizzle事前コンパイルentry](../drizzle-prepared.md)も追加し、query builderとSQL parserを配信せずに固定したクエリを実行できる。

S02ではGLOB・charをcoreへ追加し、16進・桁区切り数値literalをcompiler側で既存の値へ変換する。charのサロゲート値はTEXTで正確に表現できないため拒否する。GLOB・LIKE・unicodeがU+FFFE / U+FFFFを読むときの本家との差も修正した。

[catalogからの自動選択](../catalog-build.md)を追加。schemaと登録queryの型付きIRから必須feature・coreの27関数群・6種類の文を収集し、AOT / definedのJS・Wasmを絞る。主キー索引・SQLite出力・LTXは明示指定を維持する。続いてJOIN・通常CTE・再帰CTE・compound、JSON内部の7関数群とsubtype再解析を分割した。未使用の処理は削除し、別catalogによる追加利用はロード時に拒否する。演算子・日時・window内部の細分化と、JSONのscalar subquery / min-maxを経由するsubtype追跡は次の改善対象。

P0のV01 / C01 / R01と、P1のP01 / S01 / P02 / R02は完了。C02の[DO対応](do-consumer-sql.md)に続き、[Drizzle driver・RETURNING式・migration](drizzle.md)を追加した。[P0の基準](p0-results.md)、[P01](p01-aot-results.md)、[S01の列差分](column-delta.md)、[P02の行ページ](row-store.md)、[R02のLTX送信](aot-ltx-upload.md)、[受入条件](release-acceptance.md)、[現行の回帰・計測証拠](../../measurements/p0-completion.json)を保存した。C02の集約代表行などは未完了として維持する。

目標は、**SQLite互換の出力を保ち、軽量なブラウザ実行とオフライン同期を実現すること**。未対応は明示拒否できるが、成功した結果を別の値・型へ読み替えない。[出力互換の契約](sqlite-output-compatibility.md)を優先し、速度のためにこの条件を緩めない。0.1.0は[U01〜U09のアプリシナリオ](roadmap-0.1.0.md)の横断検証で判断する。SQLite全機能互換を0.1.0の条件とはしない。

[固定DDL＋prepared statementのバイナリ初期化](predefined-binary.md)を任意entryへ追加した。schemaとquery catalogをバイナリで読み、保存時には行・counterだけを記録する。新entryはDDL parser・ALTER・schema / ASTのJSON復元を持たない。既存の動的SQL・Drizzle・JSON AOTの経路は維持し、新形式への自動migrationは行わない。

## 1. モジュールと実行構成

| 境界 | 現在の実装 | 維持する契約 |
| --- | --- | --- |
| `mizchi/sqlike` | MoonBit製SQLiteサブセット。値・評価・制約・行ストア・SQLite reader/writer、動的SQLとAOT | Litestreamに依存しない。公開APIは`Connection` / `Statement` / `Bind` / `Column` / `Value` |
| `mizchi/sqlike/compiler` | SQL・固定schemaをビルド時に解析し、`moon-aot@1`を生成 | 配信ランタイムへSQL lexer/parserを含めない |
| `mizchi/litestream` | LTX v3生成・適用、LZ4 / CRC64、Session codec、revision・適用可否 | SQLike・SQLite・Tursoに依存しない |
| `examples/aot` | SQLikeとLTXの統合、SQLite画像とLTXの生成 | アプリ側で両モジュールを構成する |
| ホストのDB / 保存 / 同期 | TypeScriptのadapterとWorker | [Database](../../src/contract.ts)、[BrowserDatabase](../../src/backend-contract.ts)、[保存契約](../../src/persistence-contract.ts)、[policy契約](../../src/safety-contract.ts)で実装を差し替える |

`moon.work`でローカルモジュールを解決し、[外部MoonBit consumerからの利用](../../tests/workspace.test.ts)も検証している。SQLike / LTXのコアはJS / Wasm GCで動作し、外部のDB・パーサへのFFIは使わない。**ブラウザ実行経路は現在JS backend**。Wasm GCは同じ処理の差分検証・計測と生成ランタイムへの注入に対応するが、デモ全体の既定実装にはしていない。

| ブラウザengine | 実行・永続化 | SQL同期 | Session生成 / 受信 | 直接LTX受信 |
| --- | --- | --- | --- | --- |
| `sqlike`（`moonbit`はalias） | メモリ内行ストア＋IndexedDB行ジャーナル | 対応 | 対応 / 対応 | 対応 |
| `sqlite`（デモ既定） | 本家SQLite WASM＋OPFS | 対応 | 対応 / 対応 | 対応 |
| `turso` | Turso WASM＋OPFS | 対応 | 未対応 / SQL適用計画経由で対応 | 現行adapterでは未対応 |

表はadapterの能力であり、三つのSQL方言が全て同じという意味ではない。ブラウザDBの切替は保存形式の自動変換ではない。詳細は[バックエンド契約](backend-contract.md)。

## 2. SQLikeの対応範囲

「対応」は、以下の部分集合に実装と回帰テストがあることを表す。各構文の全入力・全組合せや任意のORMへの対応を表さない。AOTは事前に登録した問い合わせと固定schemaを実行し、実行中の任意DDLは扱わない。

| 分野 | 対応している範囲 | 制約・残る範囲 | 主な検証・詳細 |
| --- | --- | --- | --- |
| 値・式 | NULL / int64 / REAL / TEXT / BLOB、16進・桁区切り数値literal、affinity・三値論理、BINARY / ASCII NOCASE / RTRIM、CAST・CASE・IN・BETWEEN・GLOB・相関subquery | 独自collation・関数は不可。表現できないTEXT変換は拒否 | [値・式の差分](../../tests/sqlite-expressions.test.ts)、[基本式の追加](../../tests/sqlike-basic-expressions.test.ts)、[出力契約](sqlite-output-compatibility.md) |
| CRUD | 複数VALUES、INSERT SELECT、UPDATE / DELETE、UPSERT、IGNORE / REPLACE、RETURNING、bind | 全conflict構文・任意のSQLite拡張を受理するものではない | [4実行経路の差分](../../tests/compatibility/sqlike-paths.ts)、[追加差分](sqlite-differential-findings.md) |
| SELECT | INNER / CROSS / LEFT / RIGHT / FULL、ON / USING / NATURAL、WHERE・DISTINCT・ORDER BY・NULLS FIRST / LAST・LIMIT、GROUP BY / HAVING、複合SELECT、CTE、FROM subquery | 集約のbare column・derived tableの重複列名は保守的に拒否。複雑な問い合わせの高速化は限定的 | [外部結合・STRICT](../../tests/sqlike-outer-strict.test.ts)、[複合SELECT](../../tests/sqlike-compound.test.ts)、[FROM subquery](../../tests/sqlike-derived-table.test.ts) |
| 集約・window | COUNT / SUM / TOTAL / AVG / MIN / MAX、group_concat / string_agg、DISTINCT引数、FILTER（選択機能）、順位・lag/lead・値参照、ROWS / RANGE / GROUPSの対応frame | named WINDOW / EXCLUDE / 引数内ORDER BY等は未対応 | [windowの差分](../../tests/sqlike-window.test.ts)、[FILTER](../../tests/sqlike-aggregate-filter.test.ts) |
| JSON・日時・文字列 | JSON構築・抽出・編集・patch、順序と重複キーの保持、UTC日時・基本modifier・clock注入、charを含む基本scalar | JSON5 / JSONB、json_each / json_tree、timediff・ホストtimezone変換、全関数・全arityは未対応 | [関数の範囲](sqlike-app-features.md)、[重複JSON等の修正](sqlite-differential-findings.md) |
| schema・制約 | 通常 / STRICT / WITHOUT ROWID、IPK / AUTOINCREMENT、複合PK / UNIQUE、NOT NULL / CHECK、VIEW、基本ALTER | ATTACH / TEMP / 仮想table、任意のALTER、C ABI全体は未対応 | [移行](../../tests/sqlike-migration.test.ts)、[STRICT・機能選択](sqlike-feature-profiles.md) |
| index | 複合列・ASC / DESC / COLLATE、部分 / 式indexの宣言・一意性・保存、PK等値探索、列indexの等値prefix＋次列範囲 | 式indexによる検索高速化、複雑なORのplanner最適化、EXPLAIN計画互換は未対応 | [index範囲](sqlike-index-trigger.md)、[PK索引](../../tests/sqlike-primary-index.test.ts) |
| trigger | AFTER 3イベント、BEFOREのSELECT検証、OLD / NEW・WHEN・UPDATE OF、RAISE(ABORT / IGNORE)、再帰上限32 | BEFOREの書込、INSTEAD OF / TEMP、RAISE(FAIL / ROLLBACK)、本体RETURNINGは未対応 | [trigger範囲](sqlike-index-trigger.md)、[差分](../../tests/sqlike-trigger.test.ts) |
| FK | 複合 / 暗黙親PK、CASCADE / SET NULL / SET DEFAULT / RESTRICT / NO ACTION、遅延制約 | 他機能との全組合せの検証は未完了 | [参照動作の差分](../../tests/sqlike-foreign-actions.test.ts) |
| transaction | BEGIN / COMMIT / ROLLBACK / SAVEPOINT、文単位の取消と継続、host transaction | ネイティブVFSのロック方式を再現しない。別接続は保存世代CASで競合検出 | [ローカルtransaction](sqlike-app-features.md)、[保存契約](indexeddb-persistence.md) |
| metadata | sqlite_schema、table_info / table_xinfo、任意のindex_list / index_info / index_xinfo、FK検査、schema cookie、DEFAULT宣言の元表記 | 索引宣言順・方向を旧形式から復元できない場合は拒否。全PRAGMAではない。integrity_check / quick_checkは明示拒否 | [索引metadata](../../tests/sqlike-index-metadata.test.ts)、[監査台帳](sqlite-feature-audit.md) |

JSONの重複キーは、初期実装での拒否から**保持する実装へ修正済み**。主キー専用hash索引も実装済み。これらを未着手の改善として重ねて扱わない。

### 明示拒否とadapter固有の境界

| 境界 | 現在の扱い |
| --- | --- |
| 未知の列・関数・演算子・collation・無効な集約scope | 実行前に検査する。AOTロード時も検査し、別の意味へfallbackしない |
| 無効UTF-8のBLOB→TEXT、UTF-16画像で符号化の来歴を扱えないBLOB式 | lossyな文字列を返さず拒否。生のBLOB projectionは保持する |
| 結果の格納クラス | `bigint`がINTEGER、`number`がREAL。整数値のREALをINTEGERに変えない。NUL / BOMを保持 |
| 同期Cell | 非有限REAL・負のゼロは拒否。クエリのResultCellは専用トークンで表す。`pack()`の入力用整数推論と、出力用`packStored()` / `packResult()`は別契約 |
| Turso | SDKが型を変える整数値のNumber・非有限Numberのbindを実行前に拒否。INTEGERはbigint、整数値REALはliteral / 明示CASTで指定する |
| DO | `typeof()`とINTEGERの十進TEXT / TEXTのhexで型を復元。Number bindの型を事前確認。CTE・決定的なRETURNING式・index / table metadataに対応。非決定的なRETURNING式・subquery・名前付きbind・通常の複数文・許可外PRAGMAを拒否。trigger導入はownerのmigration scopeに限定。[Drizzle](drizzle.md) |
| Drizzle | 任意の同期driver。位置付き結果、標準列decoder、safe number、Uint8Array / int64 custom型、nested rollback、Kit履歴・hash検査。別entryの[事前コンパイル](../drizzle-prepared.md)は固定クエリを実行し、生の列位置順の結果を返す。relational custom mapper、Tursoのasync SDKは未対応。既定bundleへ含めない。[検証範囲](drizzle.md) |
| 旧保存画像 / AOT | 旧論理画像は派生cacheからDEFAULT宣言を復元し、保存bytesを変えない。宣言情報がない旧AOTのmetadata queryは再コンパイルを要求する |

## 3. 永続化・物理形式・同期

| 経路 | 対応と検証 | 残る制約 |
| --- | --- | --- |
| SQLike / AOTのIndexedDB保存 | 変更列patch / 追加行 / 削除、定期checkpoint、schema・revision・outbox・receiptの原子確定。strict complete後にACK、世代CAS、中断・ACK消失・再読込 | 全行をメモリに保持。変更した大きな列とcheckpointは全量。v1ログも読めるが、新しいv2ログの再開には新readerが必要 |
| 保存インフラの差替え | `ImageStore` / `SyncImagePersistence` / `ReplicaImageStore`とfactory注入。SQLの型・順序・replay検査は上位層が所有 | 任意の差替え先が同じdurabilityを持つと仮定しない。接続間の自動mergeはない |
| SQLite reader | committed imageのtable / index B-tree、WITHOUT ROWID、overflow、UTF-8 / UTF-16、freelist / pointer map等を検査 | 対応SQLを超えるschema・壊れた画像は拒否。hot WAL / journal復旧、VFSロック、online backup互換は未実装 |
| SQLite writer / LTX生成 | AOTの固定schemaからSQLiteページを生成。LTX v3のsnapshot / delta / shrink / no-op。JS / Wasmの同一bytes、native integrityと上流Go / 実Litestream復元を照合 | checkpoint時にSQLite画像を全体再生成。増分pager / WAL writerではない |
| SQL同期 | Node / DO正本、ブラウザ正本＋Node / DOリレー。schema stamp・結果 / 変更proof・件数条件・receiptを確認。staleや曖昧な対象は保留 | SQLの非決定性や曖昧さを自動で正しい変更へ変えない。ネットワークからtransaction制御・trigger本体DDLは受け付けない |
| Session同期 | 非NULLの宣言済みPK、old-value検査、nativeとMoonBitの相互適用 | DDLはSQL経路。Tursoは生成不可。PKなしや不完全な捕捉は受け付けない |
| trigger / FK付きbinary適用 | 任意の`withMaterializedReplication`で副作用を抑制し、全体FK・schema・利用側after条件を確認。Node / SQLike / SQLite WASMで検証 | wrapperなしでは拒否。Turso / DOに同等の抑制能力は保証しない。任意のchangesetが正しいtrigger結果かの証明ではない |
| 直接LTX受信 | `backend=ltx`でchain / checksum / page indexを検査しブラウザへ直接適用。候補画像保存→cursor確定、破損・欠落・orphan・再取得を検証 | LTXは一つの物理履歴に属し、複数writerのページ差分を意味的にmergeしない |
| AOTデモの送信 | Node relay / 専用DO gatewayへLTXを順序送信。所有者・送信先・Program・base / TXIDを固定し、durableなhash付きACKと再送・本家復元を検証 | 一つのブラウザ所有の物理履歴。DO自身のSQLiteへページをimportしない。複数writerのmerge・背景同期・live replica追従は未実装 |
| 利用側policy | `before` / `onAmbiguous` / `after`、defer / reject / 明示的な解決SQL、クライアントの置換・再取得判断 | policyはtrustedな利用アプリ側コード。通信相手が任意の実行コードを送る契約にはしない |

根拠: [保存と方式比較](indexeddb-persistence.md)、[AOT / LTX](aot-ltx-plan.md)、[R02送信](aot-ltx-upload.md)、[binary副作用抑制](sqlike-feature-profiles.md)、[同期のE2E](../../e2e/sync.spec.ts)、[直接LTXのE2E](../../e2e/moon-ltx.spec.ts)。

### 任意機能と資源上限

- ビルド時プロファイルでRIGHT/FULL・STRICT・PK索引・trigger・FK・SQL JSON・日時・window・索引metadata・集約FILTER・binary捕捉・SQLiteページ・LTXを選択する。無効機能のschema / ASTは拒否し、PK索引なしは走査へ戻す。バイナリ定義の`defined`モードも選択可能。通常の集約・CTE等の細分化は未実施。
- `mizchi/sqlike/fts`は独立した検索API。ascii / trigram・phrase / prefix / boolean・BM25を比較検証した。FTS5のSQL構文・ファイル形式の互換実装ではなく、SQL更新と別々に行った検索index更新は原子的ではない。
- LSMは独立したordered KVの**実験**。SQLike / LTXへ未接続で、reader保護付き物理GCも未実装。既定の行ジャーナルと通常 / lite / Workerのバンドルに含めない。
- 主な上限はSQL 1 MiB・10,000 tokens・式深さ64・SELECT深さ16・関数1,000引数、表 / 中間結果100,000行、画像64 MiB、AOT Program 1 MiB / 1,000 queries。経路ごとの追加制限もある。上限までの低メモリ・一定時間動作を保証する値ではない。Firefox / WebKitは未検証。

詳細: [機能プロファイル](sqlike-feature-profiles.md)、[全文検索](sqlike-app-features.md)、[LSM実験](lsm-experiment.md)、[資源上限と物理reader](moon-sql.md)。

## 4. 実施済みの最適化

高速経路は、適用条件を確認できないとき通常評価へ戻す。下表の「実施済み」はコード上の変更範囲であり、全workloadでの高速化を意味しない。

| ID | 実施した変更 | 省いた処理 | 残る費用・根拠 |
| --- | --- | --- | --- |
| O01 | 名前解決・表metadata・単純projectionの列位置を再利用。AOTは固定schemaの出力templateもProgramで共有 | 行ごとのfilter配列、名前正規化、呼出しごとの再検証と列位置計算 | 複雑な式・JOINは一般評価。行・Store・bind値はcacheしない。[P01](p01-aot-results.md) |
| O02 | 単純SELECTの候補限定、LIMIT早期停止、rowid順cache | 全行environment、不要なprojection、毎回のcopy / sort | JOIN / DISTINCT等は一般経路。rowid cacheはDMLで更新しrollbackで無効化。[実装](../../packages/sqlike/src/query_plan.mbt) |
| O03 | PKの永続HAMT、安定したrowid→slotと列indexの探索 | PK等値の線形探索、更新対象slotの再探索、clone後のPK索引再構築 | 初回構築・保持メモリ・圧縮後の再構築は残る。二次索引は配列。[P02](row-store.md) |
| O04 | 複合・降順index、増分index更新、部分indexの限定的な含意判定 | 範囲候補の全走査、毎回の全index再構築 | 配列の挿入 / 移動は残る。最大4列indexと4表のPK cacheを保持。式index検索は未実装。[増分更新](sqlike-incremental-index.md) |
| O05 | DML候補限定、変更した一意キーだけの検査、行参照の差替え | 全行の式評価、不要な一意性再検査、表全体のmap | 大量変更・制約・trigger / cascadeの評価は必要。[経緯](sqlike-optimization-plan.md) |
| O06 | 64行単位のcopy-on-write、永続vector、DELETEの空slot | cloneと通常の1行変更での表全体コピー、DELETEごとのslot移動 | 変更ページの最大64行参照＋vector経路をコピー。空slotの圧縮はO(N)、全行保持・全量checkpointは残る。[P02](row-store.md) |
| O07 | COUNT / SUM / TOTAL / AVGの直接走査と共通集約状態 | 単純集約での列解決・行environmentの割当 | GROUP BY / JOIN / DISTINCT / window等は一般経路。overflow・誤差補正は共有。[実装](../../packages/sqlike/src/aggregate_plan.mbt) |
| O08 | 変更列patch、定期checkpoint、base / LTXのbinary添付 | 通常commitの全量dump、未変更列の再保存、変更のない大きな画像のbase64再保存 | schema変更・定期checkpoint・変更した列は全量。v1 after-imageもreplay。[S01](column-delta.md) |
| O09 | AOTのSQL / schema事前コンパイル、JSON bind / 結果の直接変換 | SQL parseとparser配信、中間bind配列・結果列ごとのfilter・内部BLOB再コピー | JSON ABI・AST評価・画像再生成は残る。[AOT](aot-ltx-plan.md) / [P01](p01-aot-results.md) |
| O10 | 機能プロファイル、SDKの遅延import、FTS / LSM分離 | 不要な分岐・export・選択していないDB SDKの配信 | 通常bundlerのtree shakingだけでevaluator全体を細分化するものではない。[選択API](sqlike-feature-profiles.md) |

Web標準APIによるBase64 / JSON置換、Turso WASMの外部配信は[試作](web-platform-size.md)であり、**本番の削減実績には数えない**。AOTのSHA-256はWeb Cryptoを使用済みだが、同期transaction内のproof hashはそのまま非同期APIへ移せない。

## 5. 検証と計測の基準

### 現行の正しさの記録

段階的な互換機能の追加後の回帰はMoonBit **53件×JS / Wasm GC**、Node **362件**、Playwright **58件**と型チェック・本家Litestream復元を通過した。件数はこの更新時点の記録で、将来のテスト件数の固定目標ではない。

| ゲート | 現在の観測 | 合格が意味すること |
| --- | --- | --- |
| `just sqlite-output-check` | JS / Wasm GC / Chromium JSそれぞれ454 probe一致、248 atomic拒否、出力不一致0 | 324生成ケースを追加。観測した成功出力と拒否時の非変更が一致。未対応を一致へ合算せず、誤受理・内部例外・証拠欠落も検出 |
| `just differential-audit` | 566ケース・8経路。各環境2,256一致、4件の双方AOT prepare拒否、4件のAOT対象外DDL、不一致0 | 対応済みコーパスの新たな拒否も退行として検出。行・型・列位置・失敗後状態・接続カウンターを照合 |
| `just sqlite-audit` | **不合格を維持**。台帳1,618件中、未公開API 306・未検証599・参照ビルドになし11などが残る | 全機能互換と判定しない。出力互換ゲートの通過とは別の条件 |
| `just do-consumer-check` | 実workerdの6シナリオ・53ステップ。33一致・19明示拒否・1双方制約エラー | 型付き行と各操作後の表・監査表をnative SQLiteと照合。絶対値の初期total_changesは一致すると仮定しない |
| `just drizzle-check` | Kit生成6本＋custom 2本。Node / SQLike JS・Wasm / SQLite WASM、ブラウザIDB、実DOで通過 | 各段階のデータ・FK保持、RETURNING、再適用、履歴・失敗時rollback、オフライン再開。[制限](drizzle.md)を含む固定consumerの検証 |
| `just defined-check` | 固定バイナリDDL / named statement、JS / Wasm、IDBオフライン再開 | 上流1,000クエリをJSON / binaryのJS / Wasmで本家と照合。型・FK / trigger・wire破損・snapshot / patch・失敗時の非公開を検査 |
| `just optional-functions-check` | SQL JSON / 日時 / window / 索引metadata / 集約FILTERの個別選択・一括除去 | 必要機能不足の初期化時拒否、3モードのJS / Wasm、上流1,000クエリの6経路照合、選択したcoreだけの配信とIDBオフライン再開 |
| `just staged-compat-check` | 基本演算・優先6項目・S02・catalog自動選択の65テスト | 型・NULL・collation・優先順位・JSON表記・GLOB・char・数値literal、機能選択、JS / Wasm・バイナリcatalog・Drizzle事前定義・Chromiumの最小ビルドとIDB再開を確認 |
| `just catalog-profiles` | core 27群＋JSON 7群、6文種、JOIN / CTE / compound、schema / queryの依存、JS / Wasmの差分と2件のChromium保存検証 | 不要な実装の除去、必要な実装の保持、除外した機能を使う別catalogのロード時拒否。[通常 / 自動選択の計測](../../measurements/catalog-profiles-current.json) |

現行の証拠: [全機能監査Node](../../measurements/sqlite-feature-audit-node.json) / [Chromium](../../measurements/sqlite-feature-audit-chromium.json)、[差分Node](../../measurements/sqlike-differential-node.json) / [Chromium](../../measurements/sqlike-differential-chromium.json)。Node SQLite 3.53.4 / Chromium SQLite WASM 3.54.1を使用した。checkerは台帳・入力・ソース・成果物のhashを検査する。未検証の入力までの数学的な互換性証明ではない。

### 任意機能分割時の基準と現行レポート

以下の数値表は任意機能分割時点の記録。0.1.0以後の追加も含む現行ソースは毎回再計測し、最新の容量とSQLite比較は[README](../../README.ja.md)、機能追加前後の容量差は[段階別の記録](staged-sqlite-compatibility.md)に示す。各レポートのmeasuredAtとsourceHashesで対象を区別する。

JS runtime単体の容量はOxcで空白と識別子を圧縮し、公開APIとpurity annotationを保持する。[採用した設定](minification.md)。主キー索引だけのコアは81.09 KiB、host / 保存込み85.14 KiB（Brotli）。空白を保持していた前回の93.28 KiBとは条件が異なる。

任意機能の分割後にSQL / 行ストア / TEXT・BLOBのIDB / 配信 / DO / index・trigger比較を逐次再採取し、任意のDrizzle entry、バイナリ実行コア / host / exporterの容量も別に測る。対応前は[固定した基準](../../measurements/defined-before)、P02のcloneを伴う変更前後の比較は[行ストア計測](../../measurements/p02-row-store-paired.json)へ保存し、現行結果のhashは`pnpm exec tsx scripts/check-p0.ts`で確認する。S01の[小DB ABBA比較](../../measurements/s01-small-paired.json)は当時の結果として維持する。

| 層・条件 | 任意機能分割時の値 | 範囲 |
| --- | --- | --- |
| 1,000行・AOT主キー検索 | JS 2.43 / Wasm 1.77 / SQLite 1.59 µs | memory DB、中央値。JSON・型取得を含む |
| 同条件・SUM＋COUNT | JS 18.07 / Wasm 11.55 / SQLite 23.70 µs | 単純な集約の直接走査 |
| 同条件・1行UPDATE | JS 4.93 / Wasm 3.56 / SQLite 1.39 µs | 永続化・RPCを含まない。同じ値への反復書込 |
| 1,000行・clone＋実変更 | UPDATE JS 3.75 / Wasm 2.93、DELETE JS 2.85 / Wasm 2.14 µs | P02の変更前後の比較計測。warmな同じbaseから毎回clone、永続化なし |
| 1,000行・32更新version保持 | 追加heap JS 57.86 / Wasm 50.18 KiB | P02比較時、warmなbaseを含むGC後baselineとの差、別workload |
| IDB、1,000行×64 B TEXT・1行更新 | 全量1.639 / 列差分0.200 / ページ差分5.771 ms | strict ACKまでの平均、checkpoint込み |
| IDB、1,000行×4 KiB TEXT・commit後 | 列差分heap 6.79 MiB / backing 0.03 MiB | GC後baseline差。観測最大・保持・RSSを区別 |
| 実アプリ初回転送・Brotli | AOT 113.67 / 動的SQLike 168.66 / SQLite 474.96 KiB、Turso 3.63 MiB | page / Worker / precache / SDK込み。Drizzle / binary entryを含めない |
| AOT＋SQLite writer＋LTX単体・Brotli | JS 102.55 / Wasm 148.73 KiB | 全公開API。アプリ転送へ合算しない |
| 任意のDrizzle＋migrator追加分・Brotli | +16,904 B（16.51 KiB） | 同じSQLike adapterの計測entryとの圧縮asset合計の差。アプリ転送へ合算しない |
| バイナリ定義のJS実行コア / host込み・Brotli | 91.09 / 95.03 KiB | 固定DDL / named query、行だけの保存。任意のSQLite exporterは別83.08 KiBで、現状は評価器等の重複あり |
| バイナリ選択ビルド・core / host込みBrotli | 3機能除去84.15 / 88.17 KiB、主キー索引だけ81.09 / 85.14 KiB | 同じ公開APIの全実行機能版coreは91.09 KiB。3機能除去は6.94 KiB削減。[実測](../../measurements/optional-functions-current.json) |
| DO typed PK lookup / REAL bind×2 | SQL呼出し2回 / 4回 | 実workerd。追加費用を別計測 |
| DO typed CTE PK lookup / UPDATE RETURNING | 17.3 / 20.7 µs、SQL呼出し各2回 | local workerd。HTTPを除く。RETURNINGは同じ値への反復更新 |

保持heap・backing storageと、別workloadでのサンプリング最大を分けた。サンプリング値は未回収のgarbageを含み、観測間の一時ピークやRSSの正確な上限ではない。性能値はこの条件での観測で、全入力の保証ではない。

notes Programは20,049 B、SHA-256 `a6af7a52769d67773842aae483fcb856b46f628e31180d44afa14d2201bc2de2`のまま。これはProgramの同一性であり、ランタイム全体の容量が不変という意味ではない。

## 6. 今後の改善台帳

チェックは完了条件を満たした時点で更新する。P0は受入に必要な検証、P1は一般アプリでの費用削減、P2は拡張 / 大規模化。実測後に費用対効果で並び替える。

### P0

- [x] **V01 / P0 — 現行ソースで性能・容量・メモリの基準を再採取**
  - 完了条件: 同じSQL・seed・行数・payloadでSQL / IDB / アプリ転送 / 機能別サイズを採取しhashを記録。保持 / peak / backing storageを分離し、旧値と比較。DOの型復元による追加問い合わせも別計測
  - 依存・費用: 小〜中。最初に行い、以降の最適化の基準にする

- [x] **C01 / P0 — 出力互換・atomic拒否の生成差分を拡大。固定probeだけでは組合せが足りない**
  - 完了条件: 集約scope・collation / NUL・数値境界・JSON・bind・失敗後状態を複数seedで4経路比較。発見した差は最小の固定回帰へ追加。未対応 / 内部エラー / 不一致を分ける
  - 依存・費用: 既存の差分runnerを利用。既知の誤出力が出たら他の作業より先に修正

- [x] **R01 / P0 — U01〜U09を横断した0.1.0受入**
  - 完了条件: 必須入力・拒否入力・移行・再起動・IDB中断・ACK消失・native integrityをシナリオ別に通す。engine / 正本 / 同期modeの必須組合せと対象外を固定し、[release checklist](roadmap-0.1.0.md)を更新
  - 依存・費用: 中。C01と並行して扱える。未対応機能の全実装を条件にしない

### P1

- [x] **P01 / P1 — AOTのprepared状態・列位置・bind / 結果変換の再利用。主キー検索 / missの固定費**
  - 完了条件: まず既存ABIのままprepare / 実行 / marshalを分離計測。named queryの反復で改善し、小DB・scan・更新を退行させない。型・列順・parser除去・Program互換と配信差を確認
  - 依存・費用: V01。小〜中の変更から試し、型付きABIの形式変更は別に評価
  - 結果: [P01](p01-aot-results.md)。immutable metadataを再利用し、PK検索の所要時間をJS 57% / Wasm 67%削減。Statement保持は約0.03µsのため見送った。scanも改善、UPDATEのJS微増はサンプル範囲が重なり改善には数えない。Programは同一、AOTアプリBrotliは+147 B

- [x] **S01 / P1 — 変更列だけの永続差分。大きい未変更TEXT / BLOBまで行after-imageに含まれる**
  - 完了条件: version付き差分と旧形式replayを定義。4 KiB列を持つ1 / 16行更新で提出量を減らし、strict ACK・checkpoint込み時間・reopen・trigger・rollbackを比較。通常の小さい行を退行させない
  - 依存・費用: V01。中。単に全量dumpをdiffする実装にはしない
  - 結果: [列差分v2と検証](column-delta.md)。4 KiB列付きの通常差分は1行4,640→465 B、16行68,301→1,501 B。v1からのreplay、trigger / FK・rollback・strict ACK / checkpointを検査。REAL負のゼロの保存と、不正な整数位置・NaNの拒否も修正。小DBのABBA比較で退行は観測せず、全量checkpointの費用は残る

- [x] **P02 / P1 — 変更表内のundo / paged行コンテナー。COW後も最初の書込・DELETEがO(N)**
  - 完了条件: 同じ1行更新を100 / 1,000 / 5,000行＋無関係表で測り、コピー量と保持 / peakを減らす。trigger / FK・SAVEPOINT・host rollback・古いwriterの整合性を維持
  - 依存・費用: V01 / C01。中〜大。永続形式と実行コンテナーの変更を分離する
  - 結果: [64行COW＋永続PK索引](row-store.md)。通常の1行変更は最大64行参照＋vector経路のコピー。1,000行のclone＋UPDATEはJS 117.83→3.75µs / Wasm 26.35→2.93µs、32更新versionの追加heapは3,710→58 / 2,930→50 KiB。trigger / FK・SAVEPOINT・host rollback・stale writer・再開を検査し、保存形式とProgramは維持。AOTアプリ転送は+4,078 B。全行scanの改善はなく、圧縮・全量checkpointのO(N)は残る

- [x] **R02 / P1 — AOTで生成したLTXの送信をDO / relayへ接続**
  - 完了条件: 一つの正本履歴の所有者、base / TXID・冪等な受理・hash付きACKを定義。オフライン生成→再起動→再送→本家復元をE2E化。DOの内部SQLiteへ生ページをimportできると仮定せず、relay / 保存gatewayの役割を分ける。複数writerの物理mergeとして扱わない
  - 依存・費用: R01、LTX / policy / transport契約。中〜大
  - 結果: [一つのpublisherが所有する保存gateway](aot-ltx-upload.md)。送信先・所有トークン・Programを通信前に永続化し、LTX・受理記録・復元画像・headをCAS transactionで確定。同じファイルには同じACKを返す。Node / 実DOの両E2Eでオフライン生成→再起動→ACK消失→再送→サーバーからGETしたLTXの本家復元を通過。AOTアプリBrotliは+2,132 Bで、MoonBit runtimeとProgramは同一。通常のSQL正本とは分離し、複数writerの物理mergeは導入しない

- [ ] **C02 / P1 — consumerが必要とする明示拒否の解消。例: DOのWITH / RETURNING、metadata PRAGMA、集約代表行**
  - 完了条件: consumerの固定SQLを先に追加。正しい型・代表行・拒否時の非変更を証明できる部分だけ受理を広げる。Tursoのtyped bindはSDK能力を確認してから変更
  - 依存・費用: C01 / R01。項目単位で見積もり、現行の拒否は互換性バグとして成功へ偽装しない
  - 結果: [C02実施時の記録](do-consumer-sql.md)に続き、[Drizzle対応](drizzle.md)で決定的なRETURNING式・bindを拡張。実DOの53ステップで33一致・19明示拒否・1双方制約エラー。非決定的な式・subquery・ホストの禁止PRAGMAは維持する。生成migrationとownerのcustom trigger導入は別consumerで検証し、既定bundleへORMを含めない
  - [x] DOのCTEと列ベースRETURNING
  - [x] DOでホストが提供するindex / table metadata
  - [x] DOの決定的なRETURNING式・bind、SQLikeの修飾付きUPSERT対象
  - [x] Drizzle同期driverとKit生成6本＋custom 2本。JS / Wasm / SQLite WASM・IDBオフライン再開・実DO、FK子データ保持・失敗時rollback
  - [ ] SQLikeの集約代表行など、残るconsumer SQLの受理範囲

### P2

- [x] **B01 — 固定DDL / named statementと可変データのバイナリ分離**
  - 結果: [独立した実行entry](predefined-binary.md)。schema / statementのSHA-256と対応するschemaIdを検査し、登録済みstatementだけを実行。行だけのsnapshotと変更列journal、strict IDB / CAS、JS / Wasm・native差分、任意のSQLite出力を追加。旧JSON readerを実行コアへリンクしない
- [x] **B02a — SQL JSON / 日時 / windowの機能選択**
  - 結果: `aot` / `sql` / `defined`の各モードで独立して選択。DEFAULT・CHECK・view・triggerや未実行の式も検査し、必要機能不足は初期化時に拒否。既定エンジンをimportしないcore adapterを追加。[除去サイズ](../../measurements/optional-functions-current.json)、[SQLite差分](../../tests/sqlike-optional-functions.test.ts)、[Chromium IDB / offline](../../measurements/optional-functions-browser-current.json)
- [ ] **B02b — 旧形式import・schema migrationとexporter共通化**
  - 完了条件: 旧保存の読込とschema移行を別entryで検査し、出力・状態・拒否の非変更を維持する。SQLite exporterの評価器等の重複を減らし、コアと必要な拡張の総配信量を測る

- [ ] **P03 / P2 — 式indexの検索利用、複雑なOR / JOIN等の候補限定**
  - 完了条件: plannerが式・collation・affinity・部分条件を証明できる範囲を定義。index有無の出力差分とread / write / rollback・保持メモリ・容量を測る
  - 依存・費用: V01 / C01。中〜大。式indexの宣言 / 一意性の実装はやり直さない

- [ ] **S02 / P2 — 増分SQLite pager / writerと上限付きcache。画像再生成・全行保持が残る**
  - 完了条件: dirty pageだけの生成・保存・LTX化を設計し、native integrityと同一復元結果を検査。DBサイズ別にpeak / I/O / checkpoint / read missを計測。WAL writerは別契約
  - 依存・費用: P02等を評価後。大。現在の行差分とページ試作の速度だけで採用を決めない

- [ ] **B03 / P2 — 残るcoreの機能分割とWeb API / 配信の削減案**
  - 完了条件: 通常の集約・CTE・汎用評価器等の分割を検討。Base64 malformed入力・int64 / JSON字句 / canonical IDを維持し、Node / ブラウザ / Wasmの選択ビルドで実配信差を測る
  - 依存・費用: V01 / B02a。個別に小〜大。個別の除去量を足し合わせない

- [x] **B04 — Oxcによる生成JSの圧縮**
  - 結果: `aot` / `sql` / `defined`のJS生成へ既定で適用。公開exportとpurity annotationを保持し、後続のtree shaking・型付き結果・JS / Wasm差分・ブラウザのIDB再開を検証。[設定と容量](minification.md)
- [ ] **B05 — Jsonの再構築を省くJS向けbind / 結果ABI**
  - 完了条件: 型・int64 / REAL / BLOB / TEXT・失敗後状態の契約を固定し、既存ABIとの互換性を差分検証。SQLのJSON関数・旧形式codec・Wasm経路から分離し、配信量と速度を実測する
  - 現状: [mizchi/x/jsonの試験](json-abi.md)。bind parseだけの置換は容量が減る一方、小さい問い合わせで遅くなり、不正なサロゲートの拒否が成功へ変わったため未採用

- [ ] **V02 / P2 — Firefox / WebKit・モバイルと外部consumer**
  - 完了条件: 対象ブラウザ版・COOP / COEP・Worker / IDB / OPFS・耐障害シナリオを固定しPlaywrightで実行。ORMは版と生成SQL / migrationを固定して追加
  - 依存・費用: R01。環境ごとの能力差を明示し、Chromiumの結果を流用しない

### 実験

- [ ] **X01 / 実験 — LSMの物理GC・compaction / I/O費用**
  - 完了条件: readerを保護した回収、orphan処理、batch I/Oを検証し、ディスク増加・検索・保持 / peakと復旧を再計測。SQL接続の採否はその後
  - 依存・費用: 大。0.1.0・通常バンドルから引き続き除外

全C ABI、全PRAGMA、全拡張、ネイティブVFS / WAL復旧、非公開TH3等を含む全SQLite動作の検証は、0.1.0の必須改善に繰り入れない。[全機能監査](sqlite-feature-audit.md)の不足として継続して表示する。

## 7. 作業時の更新・採用手順

1. 台帳IDを選び、対象SQL・入力・失敗 / 復旧条件と計測範囲を固定する。現行source / artifact hashの基準を採取する。
2. **探索 → Red → Green → Refactoring**で進める。互換性の差はnative差分を先に追加し、性能変更は同じworkloadの基準値で費用を確認する。
3. 対象の局所検査の後、`just check`と`just differential-audit`を通す。未対応を含む`just sqlite-audit`は、引き続き全互換未達を表示させる。
4. 速度だけでなく、配信量・保持 / peakメモリ・durable ACK・checkpoint / reopenを必要な範囲で比較する。条件の違う記録を改善率へ換算しない。
5. この台帳に状態・採用 / 保留理由・新しい測定 / 回帰テストを追記し、該当する詳細仕様とU01〜U09の判定を更新する。古い測定は基準として保存する。

再採取の入口は次のとおり。native復元検査にはGoと実Litestreamを用意する。

```sh
LITESTREAM_BIN=/path/to/litestream just check
just differential-audit
just sqlite-bench --profile-queries=aggregate,limit,update
just aot-phase-bench
just row-store-bench
just indexeddb-bench
just build-size
just measure-aot
just feature-profiles
just aot-upload-check /path/to/litestream
just do-consumer-check
```

変更履歴と過去の倍率は[従来の最適化記録](sqlike-optimization-plan.md)、個々の測定方法は[SQL速度](sqlite-performance.md)・[IDB](column-delta.md)・[行ストア](row-store.md)・[LTX送信](aot-ltx-upload.md)・[DO consumer](do-consumer-sql.md)に残す。P0 / P01 / S01 / P02 / R02は完了。C02のDO対応分を完了し、次は残る集約代表行などの固定SQLと拒否時の非変更を先に追加して進める。
