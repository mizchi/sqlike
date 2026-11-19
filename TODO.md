# TODO

更新: 2026-11-20。現在の作業ツリーを基準にした残タスクと着手順。実装済みでも未コミット・未公開の変更を含む。作業ツリーは0.2.0のリリース準備中で、公開版は0.1.2。

優先順と完了条件はここで管理し、仕様・過去の測定は[状態台帳](docs/internal/status-and-improvement-plan.md)と各詳細ページへ残す。チェックは実装・必要な検証が完了したときだけ付ける。未対応の明示拒否は許容するが、成功した値・型・列名・順序と失敗後の状態を変えない。

## 現在地

- [x] Vite pluginでSQLファイルをスキャンし、依存する機能だけのJS AOTを生成。`@mizchi/sqlike/aot` import・型生成・サイズレポート・dev/build watch・engine cacheと独立tarball consumerを検証。通常SQL・別engineの混在はimport元を示して失敗させる。[利用方法](docs/vite-aot.md)
- [x] jev-lintの26ルールとMoonBitパーサーを導入。CIではキー不要の設定・対象範囲・マッチを検証。同期APIの型を実装から分離し、直列化キューの返り値保持を解消。[対象と実行方法](docs/internal/semantic-lint.md)
- [x] `mizchi/sqlike` / `/full` / `/aot`を分離。npmにもbaseline / full / portable AOT / JS native AOTのentryを用意。[利用方法](docs/build-targets.md)
- [x] catalogから関数群・文・JOIN / CTE / compound・JSON処理を選択。9種類のoptimizerを意味上の機能と別に選択。
- [x] JS / Wasm直接出力は単一engineを一度だけリンク。MoonBit出力はソースを生成し、利用側でリンク。AOTの外部MoonBit consumerとJS / Wasmのprepared handleを検証。
- [x] 公開APIを含む125ノード・160依存辺の閉包をZ3で検証。生成物の型・export・未使用コード除去は別の実ビルドで検査。[検証範囲](docs/internal/sqlike-build-contract.md)
- [x] 集約内ORDER BY、行値比較・複合キー探索、UPDATE FROM、VIRTUAL生成列、json_each / json_treeの初期範囲を任意機能として追加。
- [x] AOTのmetadata / 実行IR再利用、通常SQLのprepared cache、索引ブロック化、INSERT / UPDATE / DELETEの主要改善。通常式PK検索・JSON tableの単純集約・JS AOTのtyped bind / 結果も実装。[改善記録](docs/internal/performance-next.md)
- [x] 最小CRUDと全機能版のJS / Wasm容量を計測し、英語・日本語READMEへ反映。[CRUD](measurements/sqlike-crud-size-current.json) / [entry別](measurements/sqlike-entrypoints-current.json)
- [x] **B03c（portable AOT）**: 公開APIを選択し、実行用4 exportとengineなしの小さいhostを追加。既定15 exportとJS nativeの14 exportは維持。

直近のローカル確認はMoonBit 96件×JS / Wasm、Node 582件、Chromium 73件、型チェック・本家Litestream復元。601ケースの共有差分監査は各環境3,598一致・4件AOT prepare拒否・4件対象外で、不一致0。全機能監査は508 probe一致・230 atomic拒否で、SQLite全機能互換は未達。これらの件数は固定のKPIではない。CRC binary化・logical snapshotの行chunk化・旧形式移行に加え、outbox満杯時の保留とACK回収後の再開、Vite AOTのproduction/dev/watchと独立tarball consumerを検査した。

## 次に進める順番

S06a / S06bとP12a / P12bに続き、P12c・P13・C02・S03の初期範囲を実装した。続いてS02の増分pagerを、構造変更時のfallbackを残す初期範囲で実装した。未対応範囲と次の改善を下で分けて管理する。リリース準備は下のP0を別途確認する。

- [x] **S06a**: 式DEFAULT。行ごとの不足列評価、明示値の評価省略、clock・metadata・FK / trigger・再開を比較。literalの評価用データを省いて10万行INSERTを改善。
- [x] **S06bの初期範囲**: CTASの型・列名・行順・正規化SQL・rollback、catalog初期行、binary kind 7、IndexedDB offline再開、SQLite画像 / LTXを検証。compound affinity等の拒否範囲と後続は[詳細](docs/internal/schema-expressions.md)へ残す。
- [x] **P12a**: 行値metadataをprepare時に再利用。行値のaffinity / collationと値を分け、現在のbind・各行の値を使う。汎用経路とのJS / Wasm paired比較とコード除去を検証。
- [x] **P12b**: 16要素以上のscalar / 行値INリストを実行ごとに遅延索引化。int64キーを文字列化せず、NULL・NOCASE・REAL境界・restoreを検証。compoundの144型組合せ、scalar subqueryのaffinity / collationも修正。[仕様・計測](docs/internal/row-values.md)
- [x] **P13のIN集約**: 列だけを左辺にしたscalar / 行値INとCOUNT / SUM / AVG / TOTALの組合せでEnvironment / group生成を省略。[同条件の速度・容量](docs/internal/in-list-performance.md)を保存し、不要な行値実装の除去も検査。一般の結合・SET値の保持は後続として残す。
- [x] **P12cの初期範囲**: 非相関の単一表IN SELECT、一般source、DMLのliteral / bind INへcacheを拡張。4,096 entry / 推定256 KiBを保持前に共有判定。再bind・restore・相関・大payload・NULL・collation・コード除去を検査。[範囲と計測](docs/internal/in-select-performance.md)
- [x] **P13のUPDATE FROM**: 既存のrowid / IPK探索に列slot評価を接続。対象・sourceの列、SET・全predicateを準備し、必要時だけEnvironmentを生成。全SET確定後の書込順は維持。[前後比較](docs/internal/update-from.md)
- [x] **C02の代表行**: 単一MIN / MAXで代表が一意、または同点の参照列値が完全に同じ入力を受理。曖昧な値・複数極値・volatile引数は拒否し、INSERT SELECTの非変更を検査。[契約](docs/internal/aggregate-representative.md)
- [x] **S03の整数・文字列format**: format / printfを独立した関数群に追加。64bit整数、幅・精度・Unicode・NULL・上限を差分検証。版差のある空formatと未対応変換は明示拒否。[範囲](docs/internal/format-functions.md)
- [x] **S02の初期範囲**: 任意選択の増分pager、上限付きclean cache、Memory / IndexedDBのpage provider、同一transactionのLTX file / checksum状態を追加。rowidを保つUPDATEを対象にし、構造変更は全量writerへ戻す。JS / Wasm / MoonBit、native SQLite・実Litestream復元、abort / stale / ACK消失を検査。[利用方法](docs/incremental-pager.md) / [実装と計測](docs/internal/incremental-pager.md)
- [x] **S02のcheckpoint接続**: `AotDatabase`の任意ページ保存、logical / page二重CAS、同一strict transactionのcheckpointとACK済みoutbox回収を追加。旧inline履歴の切替、再開・送信再試行、abort / ACK消失を検査。[契約・利用方法](docs/incremental-pager.md#existing-durable-checkpoint-adapter)
- [x] **S02の実IndexedDB計測**: 5,000 / 100,000行、通常更新とlogical snapshotを分け、時間・全record提出量の推定・CDP観測peakを採取。全15構成のLTX / SQLite byte一致とnative integrity、reopen / ACK回収を確認。[結果と定義](docs/internal/incremental-pager-idb.md)
- [x] **S02のbinary CRC**: 8 byte / pageのCRC recordと小さいsealed headerへ分離。通常は変更分だけを読み書きし、page / LTX / logical stateと原子的に確定。旧JSON API・移行・JS / Wasm・破損拒否・再開を検査。[同じbundleの比較](docs/internal/ltx-page-checksums.md)
- [x] **S02のlogical snapshot（永続AOT）**: 全DBのJSON tree生成・hostでの再parseを、最大64行のbinary chunkへ分割。旧JSON reader・任意providerのfallbackを残し、snapshot / journal / page / CRC / LTXを同じstrict transactionで確定する。JS / Wasm、行制約・破損・欠落・abort・ACK消失・再開を検査。追加メモリは全chunk bytesに比例し、一定量にはまだ抑えていない。[契約と計測](docs/internal/logical-snapshot-chunks.md)
- [x] **S02の差分logical checkpoint**: immutableな旧partを世代付きmanifestから再利用し、変更blockだけを符号化。metadataだけなら新partを保存しない。旧partのGC・journal clear・page / CRC / LTXを同じstrict transactionに含め、旧形式移行、世代不一致、破損、abort、ACK消失を検査。初回とcold再開後の最初のcompactionは全量。[契約と比較](docs/internal/incremental-logical-checkpoint.md)
- [x] **R02のoutbox上限対応**: 既定128件でcheckpointを保留し、SQLの論理保存を継続する。再読込後も保留を判定し、検証済みACK回収後に最新SQLをLTXへ反映。再接続は既存pendingの送信→checkpoint→追加分の送信を最大2巡とし、ACK消失・実IDB・本家復元・Worker UIを検査。[契約と検証](docs/internal/aot-outbox-backpressure.md)
- [x] **schema互換性の修正**: IF NOT EXISTS / DROPの種別判定・予約名・triggerの独立namespace、schema TEXT affinityを修正。物理rootpage / rowidは明示拒否し、snapshotとtrigger再適用はadapterの`schemaEntries()`契約で順序を保つ。

| 順番 | ID / 優先度 | 作業 | 完了の判断 |
| --- | --- | --- | --- |
| 1 | P12c後続 / P1 | 一般RHS・DMLのIN SELECT再利用 | 相関・書込途中の可視性・評価順を固定し、再利用可能な形だけ拡張 |
| 2 | P13後続 / P1 | 一般結合・SET値の保持 | 一意source探索のslot化は維持し、残るEnvironmentと全対象行のSET値保持をprofile |
| 3 | S04 / P1 | 先頭WITHのUPDATE・行値SET | IRと依存関係を先に決め、自己参照・trigger・rollbackを差分検証 |
| 4 | S05 / P2 | named WINDOW・EXCLUDE | 既存のwindowFunctionsを利用し、frame・同点・NULLとコード除去を検査 |
| 5 | S03後続 / P2 | 浮動小数点format等・追加関数 | 正確な丸め・版差・容量を確認。日時・乱数・数学関数は別の関数群 |

### B03c: 最小CRUDをさらに軽くする（portable AOT完了時の記録）

同じソースの標準15 export版はJS **412.68 KiB / Brotli 77.43 KiB**、実行専用4 export版は**387.00 / 74.01 KiB**。JS約6.2% / Brotli約4.4%を削減。実行専用JS＋hostは**388.75 / 74.66 KiB**。13構成の個別API選択とhost込みを測定した。過去の403.42 KiBとは再リンク条件が異なるため、同条件対照の差で判断する。

- [x] API能力単位の到達・容量を測る。SQL JSON関数とProgram / 保存形式のJSON codecを区別する。
- [x] 実行、prepared handle、snapshot / restore、host transaction、deltaをグラフと型へ反映。SQLite / LTXの従来のfeature選択も維持し、内部rollbackは削らない。
- [x] 同じcatalog・同じ索引 / optimizer設定で比較し、最終成果物とhostを測定。deltaのみ除外した構成でも従来hostのrestore / rollbackを検査。
- [x] JS / Wasm・MoonBitソースで同じ契約を使用。不足ABIは接続作成前に拒否し、無効snapshotの読込拒否、未使用export / parser / optimizerの除去、外部consumerからの非公開API拒否を検査。

### B03d: AOTの共有処理を削る

- [x] 最小SELECT・最小CRUD・Vite既定CRUDを同条件で計測。最小CRUDのエンジンは396,291 → 373,203 B、Brotliは75,790 → 73,358 B。[計測と残る候補](docs/internal/aot-minimum-size.md)
- [x] 関数能力を直接Bool判定し、Expr / DataStatementのJSON decoderをwire契約から生成。無効なvariantはfieldを読む前に拒否する。
- [x] GROUP BYを集約関数と別の能力として収集。最小構成から不要な集約出力検証を除き、GROUP BYのみのSQLもJS / Wasmで差分検証する。

### B03e: 式の種類から必要な処理だけ残す

- [x] call / subquery / cast / case / betweenの5分類をtyped IRから収集。DDLの式や未到達のCASEも追跡し、JSON / binary readerとprepare / evaluateを同時に制御する。[結果と契約](docs/internal/aot-expression-size.md)
- [x] CASTのBoundExpression経路と、LIKEの関数検証dispatcherへの依存も切り分ける。LIKE・CTE・windowと、無効catalogの拒否をJS / Wasmで確認する。
- [x] window等の内部依存はグラフで閉じ、実際の能力定数を`plan.constants`から出力する。Z3で121ノード・155辺の宣言を再検証する。
- [x] 最小CRUDは373,203 → 356,104 B、Brotli 73,358 → 70,752 B。既定の索引・optimizer設定を維持したVite CRUDも387,678 Bへ縮小する。

### B03f: schema readerとSELECT構造を削る

- [x] FK・triggerのJSON / binary readerを、featureが有効な分岐からだけ参照する。optional fieldの既存形式、無効catalogの拒否、CASCADE・triggerの結果を検査する。[契約と計測](docs/internal/aot-structure-size.md)
- [x] source / orderBy / distinct / limitOffsetの4能力をtyped IRから収集し、不要なSource reader・FROM展開・最終sort・重複検査・LIMIT評価を除去する。windowの内部sortと集合演算は独立に残す。
- [x] 最小SELECTは300,762 → 279,898 B、最小CRUDは356,104 → 346,601 B。Brotliは61,008 → 57,231 B / 70,752 → 69,209 B。既定の索引・optimizer選択を維持し、READMEも更新する。

### B03g: 既存形式のまま小さくできる範囲

- [x] Selection / Table等のstruct JSON readerと、必須・optionalのフィールド取得を共通化。テスト専用のderive版と、受理・拒否・成功値を比較する。[範囲・費用・計測](docs/internal/aot-compact-size.md)
- [x] FROMなしのcatalogからpoint / simple scan / table集約のprepare・実行参照を切る。既定の索引・optimizer設定は維持する。
- [x] 最小SELECTは279,898 → 269,205 B、最小CRUDは346,601 → 341,255 B。Brotliは57,231 → 54,798 B / 69,209 → 67,751 B。READMEにVite既定のSELECT構成も追加する。
- [x] JSON readerのJS / Wasm microbenchmarkを保存。Wasmでは遅い平均とばらつきもあり、速度改善とは判断しない。既存API / wireを保った小型化はここで区切り、schema能力・typed ABI・query形状による選択は後続に残す。

## P0: 次のリリース前に確認すること

- [x] **意味lintの初回判定と採用箇所の修正**。プロファイルからキーを読み込み、8,518対象・回答欠落0で全体判定を記録。誤った拒否理由・private helper名・古いコメントを修正し、変更した15ファイルを3回再判定した。[結果と採用判断](docs/internal/semantic-lint.md)
- [ ] **意味lintの残余候補をレビュー**。初回530候補すべてを承認したわけではない。変更範囲の再判定にも21候補が残る。FFIのJSON error / sentinel、IDB abort経由のrejectは既存契約を維持し、failure-pathのテストexcerpt不足と実際の未到達分岐、検証と派生値回復を兼ねる関数名などを個別に照合する。cutoff変更で指摘を消さない。
- [x] **V03 — 0.2.0の性能・配信基準を再採取**。11月20日にP0必須レポート、最小AOT・entry別・CRUD容量、browser bundle・catalog比較と図表、Z3記録を再採取した。`just p0-check`でsource / artifact hashと独立consumerを照合。既存のIN list / IN SELECT・row metadata・UPDATE FROM・DEFAULT・JSON reader・10万行の専用計測は、それぞれの日付のsnapshotとして保持し、現行値としてhashだけ更新しない。[準備記録](docs/internal/release-0.2.0-preparation.md)
- [ ] **R03 — entry分割を含む現行差分のLinux CIを確認**。ローカルの回帰は通過済み。新しい`build-graph`を含む4 jobのログ・成果物を残し、過去PRの3 job成功を今回の証拠へ流用しない。
- [x] **R03 — 配布・移行手順を確定**。0.2.0としてmanifestを揃え、Mooncakes dry-run ZIPと独立したnpm tarballのJS / Wasm / browser consumerを確認した。既定機能の縮小に伴う`/full`への移行、各entryの型の独立性、JS engine併用時の重複を[英語の移行ガイド](docs/releases/v0.2.0.md)に記載。公開は別途リリース指示後。
- [ ] **Issue #1の整理**。[既存の最適化Issue](https://github.com/mizchi/sqlike/issues/1)のUPDATE metadata・parse / prepare再利用・JSON writer・索引移動等は実装済み。完了証拠と残るcold build / ABI / plannerを照合して更新または分割する。既存Issue #1の本文は未更新。AOT容量改善の後続は[schemaの除去 #7](https://github.com/mizchi/sqlike/issues/7)・[binary初期化とtyped ABI #8](https://github.com/mizchi/sqlike/issues/8)・[optimizer選択 #9](https://github.com/mizchi/sqlike/issues/9)へ分割した。

## 機能の残り

下記は初期サポート済み機能の拡張。対応済み部分を未実装へ戻さない。詳細は[段階的な互換機能](docs/internal/staged-sqlite-compatibility.md)を参照。

- [ ] **S04 — 行値・UPDATE・CTEの残り**: EXISTS内の非ゼロ小数LIMIT（現在は明示拒否）、 行値のsubquery operand / SET代入 / IN右辺compound、先頭WITHのUPDATE、trigger本体のUPDATE FROM、CTE MATERIALIZED指定。[行値](docs/internal/row-values.md) / [UPDATE FROM](docs/internal/update-from.md)
- [ ] **S05 — window・集約の残り**: named WINDOW、EXCLUDE、集約代表行規則の残り。単一MIN / MAXの一意な代表行は実装済み。集約内ORDER BY / FILTERは実装済み。C02と重複して実装しない。
- [ ] **S06 — schemaの残り**: CTASのcompound affinity・乱数を伴う重複列名・固定日時初期化、引用付きDEFAULT式、生成列のREAL affinity / ALTER / STORED、TEMP、ATTACH / DETACH。[式DEFAULT / CTAS](docs/internal/schema-expressions.md) / [生成列](docs/internal/generated-columns.md)
- [ ] **S07 — trigger・競合処理**: BEFORE書込、INSTEAD OF、RAISE(FAIL / ROLLBACK)、INSERT OR FAIL / ROLLBACK。部分成功・文取消・transaction取消と同期journalを区別する。
- [ ] **S08 — JSON・日時の残り**: JSON tableの複合root・hidden入力制約・subtype追跡、JSON集約window等、JSON5 / JSONB、timediff / timezone。[JSON table](docs/internal/json-table-functions.md)
- [ ] **S09 — 診断・metadata**: その他PRAGMA、ANALYZE / REINDEX / VACUUM / EXPLAIN、実際に検査するintegrity_check。sqlite_schemaの物理rootpage / rowidは追跡しておらず明示拒否。旧形式から復元できない索引宣言順・方向は移行契約を先に決める。
- [ ] **S10 — 仮想table**: FTS5 SQL / 保存互換、RTree、汎用virtual table API。既存の独立したFTS APIとは別の実装として扱う。
- [ ] **S11 — SQLite VFS・復旧**: WAL / hot journal recovery、VFS lock、online backup。増分ページ出力とは別の契約で、SQL行の遅延読込と総メモリ上限もここで設計する。

## 性能・メモリ・永続化の残り

- [ ] **P03 / P2 — planner拡張**: 式indexの検索利用、複雑なOR / JOINの候補限定、範囲索引・sort / LIMITのprepared plan。二次索引と複合キー探索自体は実装済み。[実行IR](docs/internal/prepared-execution-plan.md)
- [ ] **B03 / P2 — evaluatorの細分化**: schema制約の有無の分類、binary / 値生成による初期化とtyped ABI、queryの形によるoptimizer選択を測る。GROUP BY・関数判定・enum decoderはB03d、式の5分類はB03e、FK / trigger readerとSELECT構造の4分類はB03f、struct readerの共通化とFROMなしoptimizer除去はB03gで実施済み。[根拠と優先順](docs/internal/aot-compact-size.md)。SQL / defined / JS nativeのAPI選択も後続候補。追跡: [schema #7](https://github.com/mizchi/sqlike/issues/7) / [初期化・ABI #8](https://github.com/mizchi/sqlike/issues/8) / [optimizer #9](https://github.com/mizchi/sqlike/issues/9)。
- [ ] **B05 / P2 — typed ABIの残り**: binary defined、streaming / chunk。JS AOTのtyped bind・named execute・SELECT handle・独立npm entryは実装済み。Wasmの標準AOTはCell JSONを維持する。[ABI](docs/native-aot.md)
- [ ] **JSON table / P2 — 一般のWHERE / JOIN展開を軽くする**: 必要列だけの生成、DOMを作らない解析、pushdownの評価、peak / allocation計測。単純集約のvisitorは実装済み。
- [ ] **生成列 / P2 — 派生cacheの保持量を減らす**: 遅延評価・依存列だけの再計算・不要値の破棄。現在は行数×生成列数に応じて保持する。
- [ ] **B02b / P2 — 旧形式import・schema migration・exporter共通化**: 固定DDL / binary queryと行データの分離は実装済み。移行は別entryとし、旧reader・拒否後状態・総配信量を検査する。
- [ ] **S02後続（永続化）/ P2 — 増分SQLite pager / writer**: 初期のUPDATE増分化・page provider・LTX原子保存は完了。insert / delete / split / merge / freelist、cold reopenの全量生成回避を続ける。logical stateとの原子保存・既存upload / receiptによるoutbox回収は接続済み。実IndexedDBの時間・提出record推定量・CDP観測peakは計測済み。物理I/O・厳密なpeak上限は未計測。全論理行のメモリ保持とO(行ブロック数)の変更検出、logical snapshotの初回 / cold再開後の全chunk byte保持と、差分時の全manifest処理を残す。永続AOTの全量JSON化はbinary行chunkへ分離済み。CRCは変更ページ分のbinary保存へ分離済み。[初期範囲と計測](docs/internal/incremental-pager.md)。WAL recovery / VFS lock / backupはS11として分ける。
- [ ] **R02後続 / P2 — LTX gatewayの長期運用**: 履歴GC・所有権移譲・live replica・背景同期・LTX集約。pending file上限128件でのcheckpoint保留とSQL保存継続、ACK回収後のcatch-upは実装済み。単一publisherのdurable uploadと再送を維持する。複数writerの物理ページmergeとして扱わない。[gateway](docs/internal/aot-ltx-upload.md)
- [ ] **X01 / 実験 — LSMのGCとI/O**: reader保護付き物理GC、orphan、transaction集約、compactionのpayload再転送を検証。SQL接続や既定化は別判断。通常・npm bundleから引き続き除外。[LSM](docs/internal/lsm-experiment.md)

## 検証対象を広げる

- [ ] **V02 / P2 — Firefox / WebKit・モバイル**: JS / Wasm GC・Worker・IDB / OPFSの能力差、オフライン再開、保存中断、ACK消失をPlaywright等で検証。Chromiumの結果を流用しない。
- [ ] **V02 / P2 — 追加consumer**: Drizzle relational custom mapper、Turso async SDK、他のORMを固定版・固定SQLで検証。既存のDrizzle migrationと独立npm / MoonBit consumerは確認済み。
- [ ] **ビルドグラフの追加検査**: 公開APIや他の出力能力を追加したら宣言・定数・実装依存の漏れを検査する。Z3は宣言したDAGの性質を保証し、全call graph・SQL意味論・全コンパイラの正しさを証明したものとはしない。

## 作業の進め方

1. 対象IDと受入SQL / 入力 / 失敗後状態を決め、現行ソースの基準を採る。速度は5,000 / 100,000行の短いサンプル、配信量はJS minified・Brotli・Wasm、必要に応じて保持 / peakを分ける。
2. 探索 → Red → Green → Refactoring。未知機能を黙って別の意味へ読み替えない。無効ビルドの拒否と未使用コード除去も確認する。
3. 局所検証後、変更に応じて以下のゲートを使う。共通のビルド先を書き換えるタスクは同時実行しない。
4. TODOと詳細仕様・計測を更新する。容量・速度の異なる測定条件を混ぜず、完了した部分と未公開の状態を分ける。

```sh
just build-graph-check
LITESTREAM_BIN=/path/to/litestream just check
just differential-audit
just measure-crud-size
just measure-entrypoints
LITESTREAM_BIN=/path/to/litestream just pager-check
just bench-sqlite-pager
just idb-pager-check
just bench-idb-pager
# 現行ソースの性能・配信・メモリをまとめて再採取する場合
just p0-measure
```
