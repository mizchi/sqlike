# 論理checkpointを変更chunkだけ更新する

2026-11-19、未リリース。[全量のbinary row chunk](logical-snapshot-chunks.md)に、未変更chunkの再利用を追加した。周期的なcompactionで全行を再符号化せず、変わった行blockだけを保存する。対象はrepositoryの永続`AotDatabase`で、SQL実行用の全行を外部storageへ移す変更ではない。

## APIと差分判定

生成runtimeは`apiCapabilities: ["snapshotIncremental"]`を選ぶ。依存は`snapshotIncremental → snapshotChunks → snapshot`。既定15 exportとexecute-onlyには追加しない。JS / Wasm / MoonBitは同じcodecと依存グラフを使う。

`aot_snapshot_incremental`がcopy-on-writeの行rootを固定する。`aot_snapshot_reuse(current, before, index)`は、固定schemaの一致を出力前に検査し、同じprogramで物理行blockの参照が同じときだけ旧ordinalを返す。異なれば`-1`を返して再符号化する。比較は全blockを走査するが、行や大きいTEXT / BLOBを比較・hash化しない。実行cache・dirty edit履歴はbaselineへ保持しない。

SQLK v1 kind 8のframeはビルド済みprogram ID、table番号、table内block番号、最大64行とSHA-256を持つ。schemaの実行時JSON表現からdigestを作り直さず、固定program IDに結び付ける。serialや全体のordinalからも独立しているため、metadataだけの変更では再利用でき、前のtableが増えても後ろのtableのchunkを移動先から参照できる。`moon-aot-chunks@2` headerには現時点のcounter・serial・行数・block数・行を除いたschemaを持つ。kind 6 / header v1の読込は維持する。

最小CRUDの標準APIはJS 412.68 KiB / Brotli 77.43 KiB、`snapshotIncremental`を追加すると446.21 KiB / 83.72 KiB。実行専用は387.00 KiB / 74.01 KiB。[容量の全13構成](sqlike-build-contract.md#crudだけのcatalog)。

## 保存とGC

任意の`ImageStore.commitCheckpoint(expected, value)`を追加した。`value.chunks`のbytesは新規part、numberは直前のcheckpoint内のordinalを参照する。再利用時には`value.base`へ旧checkpointを確定したlogical generationを渡す。新規bytesは非同期処理の前にowned copyへ固定し、誤ったbase・範囲外・重複参照・64 MiB payload上限超過を拒否する。

IDBの`moon-snapshot-parts@2` manifestはheader text、各partの生成世代 / ordinal / byte数 / SHA-256、総payload長とmanifest全体のSHA-256を持つ。実体は`["part", birthGeneration, index]`のimmutable recordである。manifestは直接実体を指し、旧manifestを再帰的にたどらない。

1. 現在のmanifestを読み、旧世代とmeta checksumを検査する。新しいbytesだけをhash化する。
2. strict readwrite transactionでlogical generation CASとbaseを再検査する。
3. 新part・新manifest・root・journal clearを確定する。同時に、どの新参照からも使わなくなった旧partを削除する。
4. page providerを使う場合はSQLite page / CRC / LTX file / page headも同じtransactionに参加する。engineのbaselineはdurable ACK後にだけ進める。

abortではGCも取り消す。ACK消失時はhostを失効させ、reopenで確定済みのmanifestを読む。読み手はmanifestと全partを一つのreadonly transactionで取得するため、後続writerのGCで読み途中のpartが消えない。取得後にmanifest・全partのchecksumと総長を検査し、coreが行制約とschemaを検証する。未変更partのbytesはcompaction中には読み直さず、破損はread / reopenで検出する。

live part数は現checkpointの参照数に等しく、変更履歴に比例して増えない。manifestは全part分を再保存するため、metaのCPU / I/Oは依然O(block数)。payloadだけが変更分となる。

## 互換性と残る範囲

旧JSON・kind 6の全量chunkからは、最初のcompactionで全partを新形式へ置き換える。以後は同じプロセスのbaselineを再利用する。新形式を読めない旧readerは拒否する。IDB schemaはshared v4のまま。`commitCheckpoint`のないproviderは全量chunk、さらに`commitSnapshot`のないproviderは従来JSONへ戻る。

cold reopen後の最初のcompactionも全量生成する。復元時に行を再配置することがあり、保存時の物理blockとの対応を、まだ復元baselineとして引き継いでいないためである。次のcompactionから差分になる。INSERT / DELETEの影響したblockも検出するが、SQLiteページ出力の構造変更fallbackは別のまま。

差分時の追加メモリはmanifest全体＋新しいpayloadに比例する。baselineはSQL行rootを保持し、次のcheckpointまで変更前のblockを残す。初回・cold再開後は全chunk bytesを保持する。全SQL行の遅延読込、総メモリ上限、一定メモリでのstream保存は未実装。page保存を使わない旧inline SQLite base / outboxの大きいbase64 textも残る。

## 計測

以下の数値は各reportのsource hashに対応するoutbox保留追加前の測定。[上限時の保留と再接続](aot-outbox-backpressure.md)の所要時間は含めていない。

同じbundle・catalog・seedで、全量chunkの`pager-chunks`と差分の`pager-differential`を比較する。各構成で通常更新とsnapshotのwarmupを1回ずつ実施し、差分baselineを確立してから計時する。3回の中央値と、別操作のI/O・CDPメモリを採取する。

1行ずつcompactionする比較に加え、`--window=64`では各probe前にbaselineを確定し、63回のUPDATE＋checkpointを時間外で実行する。64回目の更新にsnapshotを1回要求して計る。各準備の前にpending fileをmock ACKで回収し、LTX oracle用のコピーは保持する（既存のoutbox上限128件を超えないため）。準備時間は別記録し、64更新全体の所要時間とは扱わない。journalの上限自体は変えない。

### 1更新ごとのcompaction

| 行数 / TEXT | 全量chunk→差分の時間 | 提出量の推定値 全量→差分 | 観測追加peak 全量→差分 |
| --- | ---: | ---: | ---: |
| 5,000 / 32 B | 13.35→4.77 ms | 168.33→24.94 KiB | 2.94→0.95 MiB |
| 100,000 / 32 B | 126.13→7.74 ms | 3102.76→196.49 KiB | 7.60→1.80 MiB |
| 5,000 / 4 KiB | 54.39→5.85 ms | 481.37→28.35 KiB | 2.90→1.04 MiB |

### 64更新を溜めたcompaction

| 行数 / TEXT | 全量chunk→差分の時間 | 提出量の推定値 全量→差分 | 観測追加peak 全量→差分 |
| --- | ---: | ---: | ---: |
| 5,000 / 32 B | 11.21→9.86 ms | 178.26→98.86 KiB | 1.55→0.94 MiB |
| 100,000 / 32 B | 154.80→14.15 ms | 3112.66→328.91 KiB | 7.61→1.79 MiB |
| 5,000 / 4 KiB | 51.11→29.35 ms | 491.20→233.20 KiB | 2.34→1.63 MiB |

[15構成の測定JSON](../../measurements/sqlite-pager-idb-current.json) / [64更新windowの6構成](../../measurements/sqlite-pager-idb-window-current.json)。warmup・準備・検証を除いたUPDATE＋checkpointの時間で、準備した64更新全体の時間ではない。長鎖LTXの検証は計時外で重いため、`--dataset=100000-32`等で対象を限定できる。

固定ASCII TEXTは各行で同じ値。提出量はrecord / keyの推定で、物理ディスク量ではない。CDP peakは同期処理中の一時値を取り逃す可能性がある。全構成でLTX連続適用・SQLite byte一致・native integrity・reopen・ACK回収を時間外に検査する。

```sh
LITESTREAM_BIN=/path/to/litestream just pager-check
just bench-idb-pager
just bench-idb-pager --window=64 --output=measurements/sqlite-pager-idb-window-current.json
```

## 回帰

- [JS / Wasm codec](../../tests/aot-logical-snapshot.test.ts): 未変更block、1行更新、schema / program、table増加時のordinal移動、旧wireの読込。
- [選択ビルド](../../tests/sqlike-aot-capabilities.test.ts): defaultからの除去、JS / Wasmでの再利用、MoonBit出力。
- [実IDB](../../e2e/moon-storage.spec.ts): owned buffers、base / generation CAS、不正・重複参照、GCを含むabort、manifest / partの破損拒否。
- [永続AOT](../../e2e/aot-differential-snapshot.spec.ts): v1からの移行、UPDATE / DELETE、metadataだけなら新partなし、GC、混在partのACK消失、cold再開と続く差分。
- [page原子性](../../e2e/aot-logical-snapshot.spec.ts): logical / page / CRC / LTXを同時取消、ACK消失・欠落part・再開。
