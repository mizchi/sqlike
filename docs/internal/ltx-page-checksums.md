# LTXのCRCカタログを差分保存する

2026-11-19、未リリース。[増分pager](incremental-pager.md)のCRC一覧を、全量JSONからページごとのbinary recordへ分離した。LTX v3のファイル形式・bytes・既存のupload / receipt契約は変えない。

## コントラクト

- `ltx-page-state@2`はpage size / count、TXID、全体checksum、headerのsealだけを持つ。全CRC一覧を含めない。sealはheaderのCRC64で、カタログの全走査をせずにheaderの変更を検出する。
- `crc64-be@1`は1ページにつき8 byte、big endianのCRC64。`SqlitePageCommit.checksums`は通常、変更ページと同じ昇順のpage numberだけを持つ。`checksumSnapshot`は初回・全量snapshot・旧形式の移行でのみ全catalogを置き換える。
- `readChecksums(generation, pages)`は同じ世代のCRCを要求順に連結したowned bytesを返す。IndexedDBではheadと対象CRCを同じread transactionで読み、各CRC recordのSHA-256も検査する。
- page / CRC / LTX / logical cursorは一つのstrict transactionで公開する。ページとCRCの対応漏れ・サイズ不正・世代競合は拒否し、途中abortでどれかだけを残さない。ACKによるfile回収でCRCの基準を動かさない。

値そのものは8 byteだが、IDB record・key・SHA-256の費用は別にある。カタログのrecord数はページ数に比例する。物理的な保存容量が単純に8 byte×ページ数になる、または必ず旧JSONより小さくなるとは扱わない。

## encoderと移行

`encode_ltx_pages_binary`は小さいheader、変更ページ、変更前のCRCだけからLTXと次のheaderを作る。返す`pageChecksums`は入力frameごとの新CRCを連結したbinaryのbase64表現。WasmのABIはデータと旧CRCをbase64で渡し、JSはbytesを直接渡す。

通常のdeltaで旧CRCを渡す順番は、入力ページのうち既存ページ、その後に切り詰めた末尾ページ。snapshotでは全frameからpost checksumを作るため旧CRCを要求しない。既存のframe writerを共有し、全画像encoderとのbyte一致を検証する。

旧`ltx-page-state@1`は旧codecで一度だけ全catalogを検証する。移行時は未変更ページのCRCもbinary recordへ移し、変更ページのCRCで上書きする。その後は全CRCのJSON解析・文字列化・全量保存を行わない。旧`encode_ltx_pages` APIとJSON出力は維持する。

`createPageLtxEncoder(runtime, store)`はCRC読込能力と新codecがあれば新形式を使う。storageを渡さない呼出は従来の同期JSON経路を維持する。`AotDatabase`のページ保存ではproviderの能力を使って自動選択する。新形式を保存したDBにCRC読込能力のないproviderを渡すと拒否する。

sharedなMoon / AOTのIDB schemaはv4、standalone page storeはv3へ更新する。旧logical snapshot / journalとJSON CRC stateを読み継ぐ。低いDB versionを要求する旧readerでは開けない。

## 同条件での計測

同じminified bundle・engine・catalog・初期画像を使い、providerのCRC読込能力だけを外した`pager-json`と、新しい`pager`を比較する。既存のinline checkpointも別の対照として残す。計時は1行UPDATEからlogical publicationとcheckpointのstrict ACKまで。3回の中央値で、I/Oとメモリは別probe。[詳しい測定範囲](incremental-pager-idb.md)。

| 行数 / TEXT | JSON CRC→binary CRC | 提出量の推定値 JSON→binary | head JSON→binary | CRC record書込 |
| --- | ---: | ---: | ---: | ---: |
| 5,000 / 32 B | 4.14→4.41 ms | 12.46→11.16 KiB | 2.05→0.56 KiB | 197 B |
| 100,000 / 32 B | 8.77→4.72 ms | 42.21→11.17 KiB | 31.79→0.56 KiB | 198 B |
| 5,000 / 4 KiB | 19.42→4.47 ms | 181.88→10.60 KiB | 172.03→0.56 KiB | 199 B |

| 行数 / TEXT | 通常更新の観測追加peak JSON→binary | 初期化＋初回checkpoint＋warmup JSON→binary |
| --- | ---: | ---: |
| 5,000 / 32 B | 1.24→1.45 MiB | 78.48→78.69 ms |
| 100,000 / 32 B | 1.29→0.76 MiB | 696.34→696.22 ms |
| 5,000 / 4 KiB | 6.11→1.13 MiB | 1175.10→1210.52 ms |

提出量は全record valueとkeyの定義済み推定で、物理I/Oではない。メモリは別操作のCDP観測値で、厳密な上限ではない。setupはfixture取込・初回checkpoint・warmupを含み、cold reopen単独の計測ではない。

以下の数値はCRC導入時の[9構成の記録](../../measurements/sqlite-pager-idb-before-logical-chunks.json)。logical chunkを含む最新の比較は[実IndexedDB計測](incremental-pager-idb.md)を参照。

小さいDBで速度が必ず改善するとはしない。binary経路にはCRC recordの読込とSHA-256検査が加わる。通常更新の費用を減らしても、旧JSON logical snapshotを使う対照では全量JSON化が残る。新しいproviderには[binary行chunk](logical-snapshot-chunks.md)を追加した。全論理行保持は残る。初回・cold snapshotでは全CRC recordを生成する。

## 検証と再現

- [codec差分](../../tests/ltx-binary-pages.test.ts): JS / Wasm、growth / shrink、no-op、旧JSON移行、全画像encoderとの完全一致、header seal・整数・旧CRC長の拒否。
- [host](../../tests/ltx-checksum-host.test.ts): 新形式の初期化、旧JSONの移行、通常更新の2 CRCだけの保存。
- [provider](../../tests/sqlite-page-checksums.test.ts): owned buffer、世代CAS、8 byte検査、対応漏れ拒否、shrink時の削除。
- [実IndexedDB](../../e2e/sqlite-checksums.spec.ts): DB upgrade、CRC破損時の公開拒否、cold再生成、LTX復元とnative integrity。
- [既存checkpoint](../../e2e/aot-pager-checkpoint.spec.ts): strict abort / ACK消失・再開、upload再試行、CRCを含む原子保存とfile回収。

```sh
LITESTREAM_BIN=/path/to/litestream just pager-check
just idb-pager-check
just bench-idb-pager
```

[測定JSON](../../measurements/sqlite-pager-idb-current.json)はCRCとlogical chunkを含む15構成とsource / artifact hashを記録する。[導入前の計測](../../measurements/sqlite-pager-idb-before-crc.json)は当時のsource hashを持つsnapshotで、現行ソースとの照合対象にはしない。
