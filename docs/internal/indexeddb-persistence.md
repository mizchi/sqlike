# IndexedDB の差分保存とページ保存の比較

現行の計測は[R02](aot-ltx-upload.md)、行ストアの変更は[P02](row-store.md)、保存形式は[S01の列差分](column-delta.md)を参照。P02はメモリ内のコピー単位を変え、IDBの列patch＋定期checkpointを維持する。以下は行after-image導入時点の実装・計測の記録である。

2026-11-15。SQLike / AOT の既定の永続化を、全量 JSON 保存から**行の after-image ジャーナル＋定期スナップショット**へ変更した。保存契約を実装から分離し、IndexedDB 以外のアダプターも注入できる。通常デモの `engine=sqlite` は従来の SQLite WASM / OPFS のまま。

現行 SQLike では行差分が速い。ページ方式は SQLite ファイルを毎回再構築するため不利であり、増分 pager を持つ実装全般の優劣を示す比較ではない。IndexedDB はキーと値のレコード API で、4 KiB のレコードに分けても OS の書込位置や物理ページへの整列を指定する API にはならない。[IndexedDB 仕様](https://w3c.github.io/IndexedDB/#object-store-construct)を前提に、同じ保存層へ2種類の差分を流して比較した。

## 速度

Apple M5 / macOS arm64 / Node 24.22.2 / Chromium 158.0.8127.18 / Moon 0.1.20261104 release JS。同じ AOT artifact・SQL・データを使い、全量保存、行差分、SQLite の4,096-byteページ差分を別の新規ブラウザコンテキストで逐次実行する。4,096 bytes は[SQLite の既定ページサイズ](https://www.sqlite.org/pgszchng2016.html)に合わせた。

各方式で2回 warm-up 後、7回×32操作。表は **strict commit の ACK までの全224操作の平均（ms/操作）**。定期スナップショットも除外しない。7回の平均値の中央値・全サンプル・準備と I/O の内訳は[測定 JSON](../../measurements/p0-before/indexeddb-speed-current.json)に残す。24組、5,376回の計時で、各組の終了・再開後の型付き結果を native SQLite と照合し、ページ方式の保存ファイルも native SQLite で直接開いた。

1行の整数値を同じ格納幅の値の間で交互に変更する。各行には、書き換えない疑似乱数の ASCII payload も保持する。

| 表の行数 | payload / 行 | 全量 JSON 保存 | 行差分 | SQLiteページ差分 |
| --- | ---: | ---: | ---: | ---: |
| 100 | 64 B | 0.339 | **0.188** | 0.882 |
| 1,000 | 64 B | 1.708 | **0.195** | 5.939 |
| 5,000 | 64 B | 8.596 | **0.242** | 31.028 |
| 1,000 | 4 KiB | 15.069 | **0.304** | 54.034 |

1,000行・64 B payload の内訳は次のとおり。準備には clone・SQL 実行・差分または dump の生成が入り、I/O はサイズ検査・入力バッファの確保・世代確認・IDB put・strict complete までを含む。残りの時間には ACK 後の公開などが入る。Worker RPC とサーバー同期はこの比較に含まない。

| 方式 | 準備 ms | I/O ms | 通常の差分 payload |
| --- | ---: | ---: | ---: |
| 全量 JSON | 1.295 | 0.408 | 約182 KB / 回 |
| 行差分 | **0.057** | **0.134** | **608 B** |
| ページ差分 | 5.067 | 0.870 | 12,388 B |

行差分は SQL の再実行ログではなく、順序付きの変更後の行・削除対象を保存する。ページ差分は全 SQLite ファイルの生成と全バッファの比較を含む。どちらも差分を1レコードにまとめ、世代レコードと合わせて2回の put にしている。ページごとに個別の IDB transaction を作る比較ではない。payload は IDB に渡した値の量で、物理ディスクの書き込みバイト数ではない。

### ページ方式が提出量を減らす場合

隣接する16行を一つの SQL 文で更新した場合も測定した。4 KiB payload・1,000行では、通常の行差分が **68,301 B**、ページ差分が **20,596 B** になった。現在の行差分は行全体の after-image を保存するため、未変更の大きな値も含む。

| 16行更新、1,000行×4 KiB | 行差分 | ページ差分 |
| --- | ---: | ---: |
| 通常差分の提出量 | 68,301 B | **20,596 B** |
| 定期スナップショット込み平均提出量 | 142,333 B | **75,562 B** |
| ACKまでの平均 | **1.681 ms** | 54.041 ms |

提出量だけでは速度を決められなかった。行差分には変更列だけの記録、ページ方式には writer の増分化という改善余地がある。独立コンテキストでの逐次測定・固定の方式順であり、モバイルや別ブラウザの性能を保証しない。

## メモリ

CDP `Runtime.getHeapUsage` を `HeapProfiler.collectGarbage` 後に採取した。初期化前の値との差分で、1,000行×4 KiB payload の単発観測。JS heap と ArrayBuffer / external string の backing storage は別の値として示す。

| 方式 | 通常commit直前のJS heap | 同 backing storage | commit完了後のJS heap | 同 backing storage |
| --- | ---: | ---: | ---: | ---: |
| 全量 JSON | 14.03 MiB | 0.03 MiB | 10.01 MiB | 0.03 MiB |
| 行差分 | **6.22 MiB** | 0.03 MiB | **6.20 MiB** | 0.03 MiB |
| ページ差分 | 6.24 MiB | 12.76 MiB | 6.23 MiB | 8.33 MiB |

行差分側は通常 commit の全量 dump を作らず、読み込み時の画像も接続内に保持し続けない。ページ試作は行エンジンに加え、SQLite イメージのバッファを保持する。現在の構成で、保存単位をページにするだけでメモリが減る結果にはならなかった。

これは commit 前で処理を止めて採った保持量であり、瞬間的な最大割り当て、ブラウザ全体の RSS、IndexedDB サービスのメモリではない。GC後でも非同期処理やJITの影響が残るため、初期化後・commit前・commit後の生値をすべて保存している。定期スナップショットの最大メモリはこの単発プローブでは測っていない。

**実行エンジンは全方式で全行をメモリに読む。** 行差分で保存用の一時バッファは減らしたが、DBの規模によらないメモリ上限はまだ実装していない。それを実現するには、必要なページだけを読む pager と上限付きキャッシュ、または同等の遅延読み込みが必要になる。

## インフラ境界

[persistence-contract.ts](../../src/persistence-contract.ts) が次の契約を定義する。IDB の transaction、DB名、object store名、OSのファイルパスをエンジンへ渡さない。

| 契約 | 用途 |
| --- | --- |
| `ImageStore` / `ImageStoreFactory` | AOT の非同期保存。snapshot、opaqueな差分 text、`Uint8Array` 添付、世代CAS |
| `SyncImagePersistence` / factory | 同期 SQL API の保存境界。既定は専用WorkerによるIDBブリッジ |
| `ReplicaImageStore` / factory | LTXから復元した生SQLiteイメージの候補・確定画像キャッシュ |

```ts
const db = await AotDatabase.open(name, artifact, artifactHash, customStoreFactory);
const sql = await MoonDatabase.open(name, customSyncPersistenceFactory);
```

`AotDatabase.withStore` も維持する。snapshotのみの既存実装は従来の全量保存へ戻り、`commitDelta` を持つ実装では差分を使う。NodeテストではブラウザのグローバルAPIなしに保存実装を差し替え、再開とcloseまで検証した。

保存実装は payload を解釈せず、入力を受け取った時点で固定し、世代番号のCASと原子保存を保証する。成功は durable commit 後に返す。abort・古い世代・応答喪失を解決するのは接続の再開であり、保存結果が不明な接続から次の書き込みは行わない。

## 行after-image導入時点の実装（履歴）

- MoonBit の [persistence.mbt](../../packages/sqlike/src/persistence.mbt) が insert / replace / delete の after-image を記録する。schema変更・import・restore は全量へ戻す。変更前後の順序とrowid変更を保持し、非決定的なSQLを再実行しない。4,096編集を超えた場合も全量へ戻す。
- `database_delta` / `aot_delta`、durable ACK後の `*_ack_delta`、復元用の `*_apply_delta` を追加した。AOTのProgram一致、base serial、行長・rowid・型・制約・FKを検査し、途中失敗では候補を公開しない。parserなしのAOTを維持し、旧論理画像と既存artifactの形式は変えていない。
- [MoonImageStore](../../adapters/moon-image-store.ts) はIDB v2。小さなroot、checkpoint、順序付きdeltaを分離する。世代確認で全画像を読み戻さず、差分と世代を同じstrict transactionで更新する。128レコードまたは4 MiBで次回checkpointを要求する。snapshotを確定すると旧ログも同じtransactionで消す。
- [aot-journal.ts](../../adapters/aot-journal.ts) はbase SQLite・LTXを変更時だけバイナリ添付にし、通常の行更新やACKで未変更ファイルを再送しない。互換性のため、**定期checkpointの全量SavedStateにはbase64が残る**。大きなoutboxを含むcheckpointの費用は別の改善対象である。
- AOTは復元後の全量文字列を保持せず、同期SQLブリッジも初期画像の再適用後にバッファを解放する。行値は従来どおり不変で、rollback / clone の分離を保つ。
- [IndexedDbImages](../../adapters/indexeddb-images.ts) はSQLikeの生SQLiteレプリカ画像もIDBに保存する。候補の保存完了後に論理cursorを確定し、その後にorphanを回収する。旧OPFS画像は注入した遅延フォールバックから移せる。新規DBはfilesystem APIを必要としない。このキャッシュAPIは現在も全量画像の読み書きで、ページ単位の検索キャッシュではない。

ページ差分の [page-delta.ts](../../adapters/page-delta.ts) は比較用の実装。差分バッファは大きな元画像のsubarray参照を保持せず、自分のページだけを持つ。再適用はgrow / shrink / 空画像・壊れたページ番号や長さを検証する。SQLikeの既定保存をこの方式には切り替えていない。

## 検証と再現

MoonBit JS / Wasm GC間で同じsnapshot・行差分を再適用し、native SQLiteの型付き結果、int64 / REAL / Unicode / BLOB、主キー更新、UPSERT、cascade、失敗と復元を照合した。replayの後半で失敗した場合も前半の変更を公開しない。IDBではv1画像からの移行、put後のabort、世代競合、再開、compactionを検証する。checkpoint / ACKの応答喪失も再開で回復する。

`LITESTREAM_BIN=… just check` は MoonBit **29件×JS / Wasm GC**、Node **139件**、Playwright **40件**、型チェックと本家Litestreamでの復元を通過した。SQLikeのdirect LTXでは実際のWorkerのOPFS APIを無効化したことも検査する。

```sh
just indexeddb-bench
just indexeddb-bench --smoke
just sqlike-check
LITESTREAM_BIN=/path/to/litestream just check
```

[全サンプル・メモリ・fixture / artifact hash](../../measurements/p0-before/indexeddb-speed-current.json)、[ブラウザ計測器](../../scripts/indexeddb-bench-workload.ts)、[実行とnative oracle](../../scripts/bench-indexeddb.ts)を保存する。この差分保存追加時点のライブラリ単体のBrotli増加は AOT JS +2.47 KiB / Wasm +3.52 KiB、実AOTアプリは **79.75 KiB（+3.55 KiB）**。その後の index / trigger 追加を含む[最新のサイズと実アプリ計測](runtime-size.md)を参照。
