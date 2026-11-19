# 論理snapshotを行チャンクへ分割する

2026-11-19、未リリース。永続`AotDatabase`の周期的なcheckpointで、全DBのJSON tree生成・文字列化・host側の再parse・外側JSONへのescapeを避ける。SQLiteページやLTXの形式とは独立した、SQLikeの論理状態の保存形式である。

## コントラクト

- `aot_snapshot_open`はcopy-on-writeの行ページrootを固定する。小さい`moon-aot-chunks@1` headerにprogram identity、serial、行数・block数、行を除いたschemaと接続counterを持つ。後から元DBを更新しても、出力対象の行は変わらない。
- `aot_snapshot_chunk`は物理行blockごとに最大64行を符号化する。削除済みslotは除き、残る行の順序とrowidを保つ。SQLK v1のkind 6を使い、headerのSHA-256、chunk ordinal、typed row valuesとframe全体のSHA-256を持つ。文字列poolはchunk内に閉じる。BLOB・int64・REALをJSON / base64へ変換せず保存する。
- headerは最大1 MiB、tableあたり最大100,000行、最大100,000 chunk。providerへ渡す`ImageSnapshot`はtextと全chunkを合わせて最大64 MiB。64行という上限はbyte数の一定上限ではなく、大きい行ではchunkも大きくなる。
- `aot_snapshot_restore` / `supply`はprivateな候補へ読み込む。identity・chunk順序・欠落・checksum・row数を検査し、`finish`でschema / UNIQUE / FK / generated列等の既存の行検証を行う。全検証が通るまで元DBを変更しない。途中エラーはreaderを失効させる。restore開始後に接続が更新された場合やactive transactionへは適用しない。
- autoincrement sequence、last insert rowid、changes、encoding、schema cookie、FK設定を保つ。実行cache・transaction frame・dirty editsは保存しない。JS / Wasmは同じcodecを使い、Wasmのbytes転送用にbase64 ABIも用意する。

生成runtimeでは`apiCapabilities: ["snapshotChunks"]`を明示する。通常の`snapshot`と既定15 exportへは追加せず、依存グラフ上で`snapshotChunks → snapshot`を要求する。execute-only・旧JSON snapshotのビルドにはcodecを残さない。永続repository adapterが使うexample runtimeにはcodecを含める。

## providerと原子性

`ImageStore.commitSnapshot`は任意の能力である。`PersistedImage.snapshot`は`text`とownedな`chunks`を返す。能力がないcustom providerには既存のJSON snapshotを送る。

MoonImageStoreは既存の`image` object storeに小さいmanifestと`["chunk", ordinal]`のrecordsを置く。新しいsnapshotの全chunk、root世代、journalのclearを同じstrict readwrite transactionで確定する。旧snapshotのchunkもそこで削除する。AOTのpage providerではSQLiteページ、CRC、LTX fileとpage headもこのtransactionに参加する。公開後のACKだけがengineを進め、abortなら全体が戻り、ACK消失ならreopenで確定済みの世代を復元する。chunkを準備しただけでは可視にならず、staging世代や孤立chunkのGCは不要である。

入力bufferは非同期処理の前にコピーする。readではmanifestとchunkとjournalを一つのreadonly transactionで取得し、chunk数と総byte数も確認する。generation CASのため、古いwriterはsnapshotを上書きできない。

旧inline JSON・journalはそのまま読み、次のcompactionで新形式に移る。IDB schemaはshared v4のまま。新しいmanifestを解釈できない旧readerは拒否する。旧readerへdowngradeするためのexportは今回追加していない。

## 測定

`just bench-idb-pager`の`pager`はbinary CRC＋旧JSON logical snapshot、`pager-chunks`は同じ設定＋新しいlogical chunk snapshot。同じminified bundle・engine・catalog・seedで比較し、通常UPDATEとsnapshotを1回含むUPDATEを分ける。3回の中央値、I/O・CDPメモリは別probe。[計測定義と全構成](incremental-pager-idb.md)。

| 行数 / TEXT | JSON→行chunkの時間 | 提出量の推定値 JSON→行chunk | 観測追加peak JSON→行chunk |
| --- | ---: | ---: | ---: |
| 5,000 / 32 B | 23.02→13.35 ms | 792.86→168.33 KiB | 10.56→2.94 MiB |
| 100,000 / 32 B | 224.85→126.13 ms | 15812.40→3102.76 KiB | 186.91→7.60 MiB |
| 5,000 / 4 KiB | 76.73→54.39 ms | 20636.04→481.37 KiB | 82.57→2.90 MiB |

[全15構成・source / artifact hash](../../measurements/sqlite-pager-idb-current.json)。数値はsnapshotを1回含むUPDATE＋checkpointの時間と提出量。

固定ASCII TEXTは各行で同じ値であり、chunk内のstring poolがよく効く条件である。異なるTEXTが多い実データでは提出量の減少幅が変わる。CDPの観測peakは同期処理中の一時値を取り逃す可能性があり、厳密なメモリ上限ではない。

## バンドルサイズ

`snapshotChunks`を選ぶと、最小CRUDの標準APIはJS 412.68 KiB→445.25 KiB、Brotli 77.43 KiB→83.55 KiB。選ばない標準版と実行専用JS 387.00 KiB / Brotli 74.01 KiBは従来と同程度。JSON snapshotだけの構成と独立に選び、JS / Wasm・MoonBitでも同じ依存を使う。[13構成のAPI別測定](sqlike-build-contract.md#crudだけのcatalog)。

未変更chunkを再利用する[差分checkpoint](incremental-logical-checkpoint.md)も追加した。以下は`commitSnapshot`による全量chunk経路の費用で、能力のあるproviderでは差分方式を優先する。

## 残る費用

全行を走査・符号化する時間は残る。providerへ渡す前に全chunkを配列へ集め、入力copyとStructured Cloneも行うため、追加メモリはsnapshotのbyte数に比例する。全chunkを一定メモリでstream保存する実装ではない。SQL実行用の全論理行も引き続きメモリに保持する。旧inline SQLite base / outboxを使う構成では、それらのbase64文字列も残る。

後続候補は論理chunkの差分checkpoint、世代付きstagingのstream保存、復元の遅延読込、INSERT / DELETEを含むpager拡張。今回は単一transactionの確定境界を保ったまま、全量JSONの一時展開を削った。

## 検証

- [JS / Wasm codec](../../tests/aot-logical-snapshot.test.ts): frozen root、穴のある行block、BLOB / Unicode / generated列、autoincrement、順序・欠落・破損・identity・個数・active transaction・適用中の更新の拒否。
- [実IndexedDB provider](../../e2e/moon-storage.spec.ts): buffer ownership、CAS、途中abort、journal replay、空snapshot、旧chunkの回収。
- [既存AOT checkpoint](../../e2e/aot-logical-snapshot.spec.ts): 旧JSON移行、logical / pages / CRC / LTXの同時abort、確定後ACK消失からの復元、続くjournal適用、欠落chunkの拒否。
- 全体のSQLite差分・LTX byte一致・実Litestream restoreは既存の回帰と計測scriptで確認する。
