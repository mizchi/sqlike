# 増分SQLite pagerの初期範囲

2026-11-19、未リリース。S02のうち、固定schemaのページ生成・保存・LTX化を追加した。[利用方法](../incremental-pager.md)。既存のSQL実行・logical journal・通常checkpointは維持し、新しい経路は`sqlitePages`と独立した`/pager` hostで明示的に使う。

## 何を省いたか

旧page差分は、全行からSQLite画像を生成した後、前後の全bufferを比較していた。新しい経路はpersistentな行ブロックの参照差から候補行を抽出し、B-treeを辿って必要なページだけを要求する。ページ数・rowid・cell範囲・元のrecord payload・overflow chainを確認し、変更後のleaf / overflow bytesを生成する。

値が同じ更新はrecord差分を作らない。serialが進んだ場合のheader更新は全量writerと同じ規則。rowidを変えず、通常索引のキーも変えないUPDATEに対応し、空きがあるleafではrecord長が変わっても再配置する。同長overflowはページ単位で比較して変更分だけを出す。複雑な索引・rowid変更・insert/delete・分割・sequence変更等は全量writerへ戻す。

Programへ行やページcacheを持たせない。pagerは前回ACKのimmutableな行rootとschema / serialを保持し、候補には別のrootを使う。clone・文失敗・rollback・restoreをこの境界で扱う。schema / source変更はfallback、公開後にsourceが進んだ候補のACKは拒否する。

## 保存とLTXの境界

engineは同期のpage request / supply API、hostは非同期のproviderを担当する。clean pageはhostのLRUへ置き、既定8ページ・最大128ページ。dirty page payloadは4 MiBを越えると全量生成へ戻る。clean cacheに全SQLite画像を置かない。

`SqlitePageStore`は世代CASを提供する。IndexedDBはhead・page / CRC record・LTX fileを同一のstrict transactionで確定する。入力bufferはawait前に所有し、Node Bufferのsliceによるaliasも避ける。ページ・CRC・ファイルのSHA-256を読込時に検査する。transaction complete後だけACKし、stale writer、途中abort、ACK消失後の再利用を拒否する。

`encode_ltx_pages`は旧checksumカタログと変更ページからpre / post checksumを計算し、既存encoderと同じframe writerを使う。LTXファイルと次のカタログを候補として返し、公開後だけ次の基準にする。snapshot / growth / shrink・JS / Wasmの既存全画像encoderとbyte単位で比較し、Goと本家Litestreamでも復元する。

続いて[CRCをページ単位のbinary recordへ分離](ltx-page-checksums.md)した。既存のJSON APIを残し、新しい`encode_ltx_pages_binary`は小さいsealed headerと変更前CRCだけを受け取る。通常更新では全CRCのJSON解析・保存を省き、pageとCRCの更新漏れはproviderで拒否する。

## 既存checkpointへの接続

`AotDatabase.open(..., provider?, {sqlitePages: true, cachePages: 8})`で選択する。既定の論理journalを維持し、checkpointのメタデータ更新とpage / LTX file / checksum状態を`AotPageImageStore.commitWithPages()`で一度に確定する。論理generationとpage generationは独立してCASし、通常の行書込ではpage基準を動かさない。page-backedな保存形式は`pager: {format: "aot-pages@1", generation}`で識別し、論理journalにSQLite画像やLTX bytesを重複保存しない。

`IndexedDbAotPageStore`は`MoonImageStore`のlogical snapshot / journalとpage providerを同じDBへ置く。双方のprepared writeを一つのstrict transactionへ参加させる。shared DBはv4へ更新し、v1/v2/v3のsnapshot / journalを読み継ぐ。低いDB versionを指定する旧readerは開けないため、新readerの継続利用が必要。

uploadのHTTP形式とreceipt検査は既存の`uploadAotLtx()`を使う。ACKのprefix更新と対象ファイルの物理削除を同時に確定し、`SqlitePagerClient.pruneFiles()`でcacheとengine基準を保持する。確定前abort・確定後ACK消失・再開後の再送で、ファイルを先に削除しない。SQL transaction中のcheckpoint / ACKは拒否する。

旧inline形式のLTX履歴は、保存baseから一度だけchecksum状態を計算する。次の変更checkpointでlogical snapshotをcompactし、既存のpending bytes・TXID・upload bindingを保ってpage保存へ移す。abortは元の形式を残す。新形式のreopenはpage cursor・checksum TXID・pending manifestとhashを照合し、snapshot-only providerには渡さない。

## 計測

既存checkpointを含めた[実IndexedDBの時間・全record提出量・メモリ観測](incremental-pager-idb.md)を追加した。以下はMemory providerによるページ生成 / LTX処理の比較で、別の測定範囲。

計測日: 2026-11-19（JST）。Apple M5、Node 24.22.2、MoonBit 0.1.20261117。1回warmup＋3回の中央値。単一行の整数を同じrecord長で更新し、SQL実行後からページ生成・比較・LTX・Memory providerの世代CAS完了までを測る。seed / 初回snapshot / GC / 復元照合は時間から除外。

| 行数 / TEXT payload | JS 全量→増分 | Wasm 全量→増分 | 生成ページ 全量→増分 |
| --- | ---: | ---: | ---: |
| 5,000 / 32 B | 29.12→3.83 ms | 15.25→0.94 ms | 54→2 |
| 100,000 / 32 B | 328.88→10.37 ms | 283.63→1.79 ms | 1055→2 |
| 5,000 / 4 KiB | 1044.45→25.15 ms | 1359.26→4.87 ms | 5629→2 |

全量経路は旧画像生成＋全buffer比較＋全画像LTX、増分経路はpager＋page checksum状態を使う。同じAOT engine・catalog・公開APIを両経路で使用し、どちらもpage / LTX file / 状態を同じMemory providerへ公開する。このMemory比較はstorageを渡さない従来のJSON CRC経路。binary CRCの効果は同じbundleで比較した実IndexedDBの記録で判断する。各回、出力SQLite画像が全量writerとbyte単位で一致することを時間外で検査する。

両経路とも保存する**ページpayloadは2ページ・8 KiB**。改善は全量生成・比較・CRC計算を省くCPU処理にあり、全量生成後のpage差分保存と比べてページ書込量が減ったという測定ではない。圧縮LTX fileとO(ページ数)のchecksum JSONも保存するため、総I/Oが8 KiBだとは主張しない。provider readは小recordで1ページ、大recordで2ページ、clean cacheは32 KiB。10万行では1,563個の行ブロック参照を走査する。

この値は実IndexedDB・networkの時間を含まない。Wasmは全画像経路のbase64転送と、増分経路のページ単位転送の差も含む。reportのheap / backingは呼出後とGC後の差分であり、実行中peak・RSS・Wasm全メモリではない。全論理行はメモリに残る。

[測定JSON](../../measurements/sqlite-pager-current.json)は全sample、工程別時間、呼出後 / GC後のメモリ観測とsource / artifact hashを含む。[計測script](../../scripts/bench-sqlite-pager.ts)。

## 検証

checkpoint接続後のローカル確認はMoonBit 93件×JS / Wasm、Node 560件、Chromium 70件。SQLite出力監査は各環境508 probe一致・230 atomic拒否・出力不一致0。npm tarballの独立consumerでは`/pager`のengine除去と、page単独書込を公開しない型契約も確認した。

- [pager / native SQLite](../../tests/sqlike-pager.test.ts): leaf再配置・overflow・索引fallback・int64両端と負のrowid・BLOB・no-op・文失敗・rollback・restore・stale ACK。
- [provider / ACK消失](../../tests/sqlite-page-store.test.ts): owned buffers・Node Buffer・世代CAS・growth / shrink・LTX fileとchecksum状態の原子確定。
- [AOT / binary](../../tests/sqlike-pager-profile.test.ts): JS / Wasm、任意選択、未使用コードとSQL parserの除去。
- [外部MoonBit consumer](../../tests/sqlike-moonbit-emitter.test.ts): 同じpager APIをJS / Wasmで利用。
- [LTX](../../tests/ltx-pages.test.ts): snapshot・増分・縮小・state再開と全画像encoderの一致。
- [実IndexedDB](../../e2e/sqlite-pager.spec.ts): file書込中のabortでpage / head / outboxを全て取消。世代競合・再読込、Go検証・実Litestream復元。
- [既存checkpoint](../../tests/aot-pager-checkpoint.test.ts): UPDATE増分化、logical journalのpayload重複除去、旧inline履歴の切替、upload ACK消失と再送、pruneのabort / ACK消失、SQL transaction・hash・cursor不一致の拒否。
- [原子checkpointの実IndexedDB](../../e2e/aot-pager-checkpoint.spec.ts): file put中断でlogical / pageを同時取消。確定後ACK消失・reload、二つのgenerationのCAS、Node relayへの実送信・再試行・GC、Go / 本家Litestreamで復元。

```sh
LITESTREAM_BIN=/path/to/litestream just pager-check
just bench-sqlite-pager
just idb-pager-check
just bench-idb-pager
```

## 残る範囲

- SQLikeは全論理行をメモリに保持する。これはDB全体を外部page cacheへ移したVFSではない。
- 初回・cold reopen・構造変更の全量writerを残す。全B-treeのinsert / delete / split / merge・overflow再割当・freelist管理は後続。
- 変更検出は論理行ブロック数に比例する。binary CRCのrecord数は全ページ数に比例するが、通常更新は変更分だけを保存する。旧JSON経路は一覧の全量処理を残す。どちらもmetadata / journal / file / keyを持つため、提出量はdirty page payloadだけにはならない。
- immutableな行root、encoded record、dirty candidate、初回snapshotはclean cache予算の外。全heap・Wasm使用量・RSS・実行中peakを上限付きにしたとは主張しない。
- `AotDatabase.checkpoint()`との接続・logical stateの原子保存・既存upload / receiptによるoutbox回収は完了。送信開始はアプリが明示する。背景同期・gatewayの履歴GC・所有権移譲はR02後続。WAL recovery・VFS locking・backup APIはS11として残す。
