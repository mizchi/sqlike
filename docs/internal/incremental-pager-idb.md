# 増分pagerの実IndexedDB計測

2026-11-19、未リリース。既存の永続`AotDatabase`について、inline形式・増分pager＋JSON CRC・増分pager＋binary CRC・同pager＋binary logical chunk・差分logical checkpointの5構成を比較した。[利用方法](../incremental-pager.md#existing-durable-checkpoint-adapter) / [実装とMemory providerの計測](incremental-pager.md)。

以下の数値は各reportのsource hashに対応するoutbox保留追加前の測定。後続の[上限時の保留と再接続](aot-outbox-backpressure.md)は回帰テストで検証し、満杯時やネットワークの性能測定は含めていない。

## 比較条件

Apple M5、Node 24.22.2、Chromium 158。全構成で同じAOT engine・catalog・初期論理画像・OXC minified JS bundleを使う。CRCのJSON / binary対照はproviderのCRC読込能力だけを切り替える。logical chunkと差分の対照はcommitSnapshot / commitCheckpoint能力を切り替える。[CRCの比較](ltx-page-checksums.md)。Wasm版の比較ではない。TEXTは変更しない固定ASCII文字列で、整数1列をrecord長が変わらない値へ更新する。

計時は**SQL UPDATEの実行からlogical publication・checkpointのstrict transaction完了まで**。初期化・初回LTX snapshot・復元照合・reopen・ACK回収・networkは除外する。通常更新とsnapshotのwarmupを各1回、各条件3回の中央値。GCは計時の外で行う。少数sampleの短い計測で、長期運用の平均値やp95ではない。

- **通常設定**: logical journalの128 record / 4 MiBという自然なcompaction条件を維持する。snapshotが自然発生した場合も時間・提出量へ含める。
- **snapshotを1回含む条件**: UPDATEを始める前に各経路のlogical snapshotを1回要求する。通常更新だけの速さと、周期的に残る全量処理を分ける。
- **提出量**: I/O専用の別操作で、すべてのIDB put/get valueとkey、delete / clearの件数を採取。value内のbinaryをnullへ置き換えたJSONのUTF-8長＋binary viewの長さ＋put/get keyのJSON長を集計する。Structured Cloneの実装、物理ディスクI/O、IDB内部の索引やGCのbyte数ではない。
- **メモリ**: さらに別の操作でCDPを約2 ms間隔で採取する。JS heapとbacking storageを同一sampleで加算した観測最大値を使う。同期処理中の一時値を取り逃す可能性があり、厳密なpeak上限・RSS・IndexedDBサービスのメモリではない。

計時中に提出値のJSON化やCDPのsamplingを混ぜない。提出量は専用操作1回、メモリも専用操作1回の観測値であり、3回の計時sampleの中央値ではない。

## 結果

### 通常設定

| 行数 / TEXT | 旧inline | binary CRC pager | 全量行chunk | 差分行chunk |
| --- | ---: | ---: | ---: | ---: |
| 5,000 / 32 B | 34.52 ms | 5.34 ms | 4.52 ms | 4.09 ms |
| 100,000 / 32 B | 699.14 ms | 4.89 ms | 4.70 ms | 4.89 ms |
| 5,000 / 4 KiB | 1771.76 ms | 4.99 ms | 4.96 ms | 5.06 ms |

旧inlineはSQLite全画像をjournalへ再保存し、100,000行と4 KiB TEXTでは4 MiB閾値を超えて自然なcompactionも発生する。差分logical checkpointが主に減らすのは周期的compactionの費用で、通常のUPDATE / page経路は共通する。

### logical snapshotを1回含む条件

| 行数 / TEXT | 旧JSON logical image | 全量行chunk | 差分行chunk | 提出量の推定値 全量chunk→差分 |
| --- | ---: | ---: | ---: | ---: |
| 5,000 / 32 B | 23.02 ms | 13.35 ms | 4.77 ms | 168.33→24.94 KiB |
| 100,000 / 32 B | 224.85 ms | 126.13 ms | 7.74 ms | 3102.76→196.49 KiB |
| 5,000 / 4 KiB | 76.73 ms | 54.39 ms | 5.85 ms | 481.37→28.35 KiB |

各構成でlogical snapshotのpublicationを1回確認する。差分経路は初回snapshotをwarmupで確定済み。計時の最初のsnapshotには、その前の通常更新で変わったblockも含み、後続snapshotでは前回からの変更分を処理する。固定の同じTEXTが全行に入るため、chunk内string poolの効果も含む。

### compactionの観測追加メモリ

| 行数 / TEXT | JSON pager | 全量chunk | 差分chunk |
| --- | ---: | ---: | ---: |
| 5,000 / 32 B | 10.56 MiB | 2.94 MiB | 0.95 MiB |
| 100,000 / 32 B | 186.91 MiB | 7.60 MiB | 1.80 MiB |
| 5,000 / 4 KiB | 82.57 MiB | 2.90 MiB | 1.04 MiB |

GC済みの操作直前からのCDP観測差で、JS heapとbackingを同一sampleで加算する。同期処理中の一時値、RSS、IDBサービスのメモリは含まない。全SQL行を保持し、差分時も全manifestと新しいpayload、初回 / cold再開後は全payloadを処理する。

### 64更新を溜めた条件

| 行数 / TEXT | 全量chunk→差分の時間 | 提出量の推定値 全量→差分 | 観測追加peak 全量→差分 |
| --- | ---: | ---: | ---: |
| 5,000 / 32 B | 11.21→9.86 ms | 178.26→98.86 KiB | 1.55→0.94 MiB |
| 100,000 / 32 B | 154.80→14.15 ms | 3112.66→328.91 KiB | 7.61→1.79 MiB |
| 5,000 / 4 KiB | 51.11→29.35 ms | 491.20→233.20 KiB | 2.34→1.63 MiB |

各probeの前に63回のUPDATE＋checkpointを計測外で実行し、64回目にcompactionを要求する。準備前にpending filesをmock ACKで回収し、LTX oracle用コピーは保持する。128件の既存outbox上限を避けるためで、networkの計測ではない。準備時間とabsolute heapもJSONへ記録する。[6構成の測定](../../measurements/sqlite-pager-idb-window-current.json)。

## 改善対象

1. 差分checkpointでもmanifestと変更検出は全block分を処理する。木構造や変更blockの追跡で減らす余地がある。
2. 初回 / cold再開後の最初のcompactionは全量。stream保存、復元baselineの引継ぎは後続。
3. INSERT / DELETEを含むSQLite構造変更、遅延読込、全SQL行のメモリ上限、他ブラウザは今回の速度比較の範囲外。

## 再現・検証

```sh
# 小さいfixtureで計測・LTX・SQLite整合性・reopen・ACK回収を確認
just idb-pager-check
# 5,000 / 100,000行と5,000行×4 KiB、各3 sample
just bench-idb-pager
# 64更新windowは全量chunk / 差分の2構成に限定
just bench-idb-pager --window=64 --output=measurements/sqlite-pager-idb-window-current.json
# 個別条件は既定で/tmpへ保存。全体レポートを上書きしない
just bench-idb-pager --dataset=100000-32
```

[計測script](../../scripts/bench-idb-pager.ts) / [browser workload](../../scripts/idb-pager-workload.ts) / [提出量の定義とテスト](../../tests/idb-pager-metrics.test.ts) / [測定JSON](../../measurements/sqlite-pager-idb-current.json)。

各経路のpending LTXを順に適用し、現在のSQLite画像とbyte単位で比較する。native SQLiteのintegrityと件数・更新値の合計・TEXT長を検査し、全構成の最終SQLite hashの一致も要求する。logical reopen、変更のないcheckpoint、ACK後のoutbox回収も検査する。source / bundle / engine hashを測定前に固定し、測定終了時にも一致を確認する。
