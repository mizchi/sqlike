# 通常SQLのparse・prepare再利用

2026-11-17、未リリースのP07。通常SQLに接続内LRUを追加し、既存のuncached SQL APIを残して別経路として比較する。公開入口は`openDatabase(image?, { statementCache: { capacity, maxSqlBytes? } })`。既定は無効。

## 契約と所有権

ホストはSQL文字列からopaqueな`SqlPrepared`を取得する。初回にDML / SELECTのASTをparseし、bindの形式・件数・readonly条件を確認した後でschema依存metadataを準備する。単純な主キーSELECTとUPDATEはAOTと共通の準備済み実行計画を使う。複雑なSELECTは対応する出力・射影metadataを再利用し、INSERT / DELETEはASTを再利用する。行・bind値・結果・clock・counterは毎回取得する。

DDL / transaction / PRAGMAのASTは保持して実行しない。例えばCREATE TABLEは可変のtable定義を実行器へ渡すため、通常のparser / executorを通す。初回の分類parseが追加されるが、繰り返しDDLの高速化をこのcacheの効果に数えない。構文エラーのhandleも同じ上限内に保持できる。schema依存の準備エラーは永続化せず、後のschema変更で再検査する。

`SqlPrepared`は作成元runtime・Databaseを所有するopaque handleであり、別接続への流用APIではない。ホストLRUは接続単位で、globalなStatement / Store / parameter cacheを置かない。直接この低レベルAPIを使って保持したhandleの寿命は呼出し側が管理する。以下の上限は`openSql` / `openDatabase`のLRUに適用する。

| 設定 | 契約 |
| --- | --- |
| `capacity` | 0で無効、最大256件。明示したobjectでは必須 |
| `maxSqlBytes` | 既定65,536、1〜4,194,304 B。各SQLのUTF-16 code unit数×2の合計 |
| 上限超過 | LRUを退避。単独でbudgetを超えるSQLはuncached実行へ戻す |
| 追加メモリ | AST・metadata・Mapの管理領域はSQL text budgetとは別。heap全体のbyte上限ではない |
| close / host rollback | handleの保持参照を破棄。rollbackでDatabaseが差し替わった後は新しい所有者から取得する |

## schema世代

schema cookieだけでは、transactionでcookieが戻り、別のDDLが同じ値へ進むABAを検出できない。Databaseへ保存対象外の`schema_epoch`を追加した。成功したSQL / typed Statementがcookieを変更すると進め、restore・SQLite import・flush適用によるStoreの差替えでも進める。失敗した復元は元の状態を維持する。

prepared metadataのepochが異なれば、現在のStoreから再準備する。rollback時にこの世代を保存画像から戻さない。host transaction / savepoint / captureがcloneへ接続を差し替える場合は、ホストLRUもclearする。copy-on-writeによる失敗文の取消ではschemaが同じなのでmetadataを再利用できる。feature構成はruntimeに固定され、異なるruntime間でhandleを共有しない。

Program、Cell JSON、論理画像、バイナリschema / statement / 行snapshotの形式は変更しない。AOT / definedへSQL parserやLRUは追加しない。共有Databaseに世代のbookkeepingを加える費用はサイズ・通常AOTの計測にも含める。

## 比較とメモリ

<!-- dynamic-prepare-speed:start -->
5,000行、単位µs、warmな反復7回の中央値。矢印は同じページのuncached → cached SQL。

| workload | JS | Wasm GC | SQLite WASM prepared |
| --- | ---: | ---: | ---: |
| 主キー hit | 26.10 → 1.03 | 5.80 → 0.86 | 1.42 |
| 主キー miss | 26.61 → 0.54 | 5.32 → 0.46 | 0.46 |
| UPDATE（同値反復） | 14.25 → 2.75 | 4.60 → 1.74 | 1.34 |
| 範囲＋ORDER BY | 40.88 → 5.25 | 11.51 → 4.79 | 10.43 |
| LIMIT | 37.77 → 3.88 | 8.78 → 3.45 | 9.33 |
| SUM＋COUNT | 96.62 → 76.04 | 50.80 → 48.31 | 104.10 |
| 全行読取 | 1740.00 → 1683.87 | 1916.00 → 1888.46 | 4572.73 |

実変更＋範囲読取の1 cycleは以下。UPDATE単独の時間ではない。

| workload | JS uncached → cached | Wasm uncached → cached | SQLite prepared |
| --- | ---: | ---: | ---: |
| 索引値の局所変更 | 62.55 → 7.51 | 16.99 → 7.00 | 11.72 |
| 索引の両端へ移動 | 74.03 → 16.51 | 18.76 → 8.71 | 12.67 |

1,000行DB、32 plan保持時のGC後heap差分。clear後も同じbaselineとの差を示す。

| runtime | 保持中の追加heap | clear後の差分 | 保持中の追加backing storage |
| --- | ---: | ---: | ---: |
| JS | 136.31 KiB | 6.95 KiB | 1,623 B |
| Wasm GC | 49.50 KiB | 0.25 KiB | 0 B |
<!-- dynamic-prepare-speed:end -->

[`dynamic-prepare-current.json`](../../measurements/dynamic-prepare-current.json)は同じChromiumページの8経路を比較する。既存6経路を残し、SQLike JS / Wasmのprepared経路は本番と共通の32件・64 KiB LRUを使う。全経路でsetup・load・compileを除外し、SQLikeは事前encode済みbindと返り値のJSON.parseを計時する。ホストの値encodeとclock設定は含めない。native SQLiteで型付き結果と更新後を確認し、7回・順序入替の中央値を使う。SQLite SDKとはABI費用が同一ではない。

主表のUPDATEは最初の変更後に同じ値を書き続ける。`indexLifecycle` / `indexMovement`は値を交互に変え、索引値の局所更新 / 両端移動と範囲読取を別に測る。`firstRangeRead`は一回のcold呼出しで、中央値や一般的な初期化費用には使わない。

retention probeは計時・profileの後にGCを実行し、未変更の行を読む32個の異なるSQL / planを保持して再GC、clearして再GCする。SQL textは3,244 B。CDPのheap / backing storageをraw値で保存する。JIT・engineの派生cacheを含み、RSS・厳密なallocation量・peak・byte上限ではない。

<!-- dynamic-prepare-size:start -->
[追加前](../../measurements/dynamic-prepare-before/wasm-build-size-current.json) / [追加後](../../measurements/wasm-build-size-current.json)の単体engine。JSはOxc minify済み・未圧縮とBrotli。host・loader・アプリを含まない。

| engine | JS minified 前→後 | JS Brotli 前→後（増分） | Wasm raw 前→後 |
| --- | ---: | ---: | ---: |
| AOT + SQLite writer + LTX | 596,369 → 596,618 B | 112,305 → 112,370 B（+65） | 524,609 → 524,508 B |
| SQLike dynamic SQL | 625,026 → 641,016 B | 117,508 → 119,634 B（+2,126） | 553,147 → 564,056 B |
| Litestream | 157,720 → 157,720 B | 38,291 → 38,291 B（+0） | 132,760 → 132,760 B |

通常SQLは新しいprepared exportも保持した増分。AOTの共有Database bookkeepingはBrotli +65 Bで、catalog選択AOT / definedから新しいSQL準備関数が消えることをテストする。host込みの容量は[README](../../README.ja.md)へ反映した。
<!-- dynamic-prepare-size:end -->

## フェーズの分離

[`dynamic-prepare-phases.json`](../../measurements/dynamic-prepare-phases.json)はNode上のMoonBit release microbench。1,000行の同じ主キーSELECTで、parse、schema metadata準備、bind decode、準備済み評価、結果JSON、uncached / prepared JSON ABIを独立して計測する。初期化は計時外。各平均値を加算してブラウザの中央値へ対応させない。

<!-- dynamic-prepare-phases:start -->
単位µs、各probeの平均値。ブラウザの中央値とは別の実行。

| probe | JS | Wasm GC |
| --- | ---: | ---: |
| parse | 12.300 | 2.730 |
| prepare metadata | 3.290 | 3.220 |
| bind decode | 0.260 | 0.240 |
| prepared execution | 0.136 | 0.112 |
| result JSON | 0.108 | 0.255 |
| uncached JSON ABI | 15.130 | 6.300 |
| prepared JSON ABI | 0.521 | 0.605 |
<!-- dynamic-prepare-phases:end -->

dynamic / preparedのCPU profileも別々に採取する。分類は最も内側の識別可能なstackに帰属させる。例えばparser内のidentifier正規化がcolumn resolutionへ分類される場合があり、分類割合を厳密なフェーズ時間と解釈しない。

## 検証と残る項目

[`sqlike-sql-cache.test.ts`](../../tests/sqlike-sql-cache.test.ts)でLRU・SQL予算・型切替・同値更新・readonly・FK / trigger・constraint失敗・host rollback・savepoint・同cookieのrestore・clock / counterを照合する。[whitebox](../../packages/sqlike/src/sql_prepared_wbtest.mbt)はDDL rollbackのABAとepochによる再準備を確認する。差分コーパスへNode / ChromiumのJS / Wasm cached SQLを追加し、566ケース×12経路を要求する。npmの独立したconsumerもcacheを有効にして上流1,000 queryとDrizzle migrationを検証する。

schemaが変わる度にmetadata全体を再準備する。表単位の無効化や、キャッシュサイズの自動調整は未実装。一般のWHERE / JOIN / 範囲索引の専用plan、INSERT / DELETEのmetadata準備、直接typed ABIは別の改善対象として残す。

```sh
just sql-prepare-bench
just differential-audit
LITESTREAM_BIN=/path/to/litestream just check
just p0-measure
just bundle-size
pnpm exec tsx scripts/check-p0.ts --record
```
