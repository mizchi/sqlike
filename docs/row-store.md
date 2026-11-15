# P02: 変更表内のコピーをページ単位にする

2026-11-16。開発版0.0.1の行コンテナーを、表全体の配列COWから64行単位のCOWへ変更した。clone時に主キー索引も共有し、通常の1行更新・削除で全表をコピーしたり、主キー索引を再構築したりする費用を減らす。

以下の計測はP02完了時点へ固定した。現行の送信機能と再計測は[R02](aot-ltx-upload.md)を参照。

## 行とsnapshotの所有

[RowPages](../packages/sqlike/src/row_pages.mbt)は64行のページを持ち、ページ一覧には標準ライブラリの永続vectorを使う。Storeをcloneすると、小さなwrapperと所有epochを作り、ページrootを共有する。書込時は共有ページだけをコピーし、そのStoreが所有するページへの続く書込は同じ配列を使う。変更しない行の値やTEXT / BLOBを複製しない。

通常の書込でコピーする行参照は最大64個。それにvectorの経路のコピーが加わり、表の全行数に比例する配列コピーを避ける。Storeのschema / 列metadata等のコピーは残るため、DB全体のclone費用を常にO(1)とするものではない。

行を走査するcursorもページrootを保持し、現在の所有epochを共有済みにする。走査中のcallbackやtrigger処理が表を書き換えても、cursorは以前の行を読む。SQLの候補行配列と、不変のStoredRow / Valueを使う既存の契約も維持する。

[構造のテスト](../packages/sqlike/src/row_pages_wbtest.mbt)では、5,000行のsnapshotを保持して1行更新したとき、コピーされたページが64行分だけであることを検査する。所有済みページの再利用、cursor保持中の変更、64行境界、削除後の圧縮と古いsnapshotの独立性も検査した。実行時の計測カウンターを増設して数値を作るテストではない。

この「ページ」は**メモリ内の行参照のCOW単位**であり、SQLiteのB-treeページ・4 KiB物理ページ・IDBレコードとは別のものになる。

## 削除と索引

DELETEは物理slotを空にし、他の行のslotをずらさない。通常は全表のfilterとslot索引の再構築が不要になる。空いたslotはappendへ再利用せず、既存の物理行順と末尾への追加を保つ。

空slotの増加を放置しないため、使用slotが128を超え、かつ生存行数の2倍を超えた場合に詰め直す。空表になった場合もページを解放する。**この圧縮はO(N)**で、そのStoreのslot索引を無効化する。DELETEが常に一定時間になったという主張ではなく、毎回の全表コピーを避けて圧縮費用を償却する設計である。

[主キー索引](../packages/sqlike/src/primary_index.mbt)は永続HAMTのrowid→slotと、複合主キー→rowidを持つ。行そのものを索引にも重ねて保持せず、現在のページから読む。cloneで索引wrapperを分け、rootは共有する。rowidや主キーが変わらない更新では、slot rootもそのまま使う。削除・キー変更は別のrootを作り、古いStoreのrootは変更しない。

二次索引の配列・制約の全走査・FK処理まで永続treeへ変更したものではない。二次索引cacheは従来どおりcloneで再構築対象になり、schema変更もcacheを無効化する。最初の主キー索引構築、bulk DML、DELETEの圧縮、全量画像の再生成には行数に比例する仕事が残る。

## 保存形式と適用の互換性

ページ・slot・epoch・HAMTは保存しない。[Tableのserializer](../packages/sqlike/src/strict.mbt)は生存行を従来の順序で配列化し、readerは旧配列からページを構成する。`moon-sql@1` / `moon-aot-image@1`、v1 snapshot / after-image、[S01のv2列patch](column-delta.md)、AOT Programの形式は維持した。v1/v2ログはrowidで適用するため、圧縮や再開でslotが変わっても再生できる。

statement失敗時の復旧、SAVEPOINT、hostのprivate candidate、stale writerの公開拒否は同じ境界で行う。古いwriterやsnapshotのページと索引を、現在の書込で変更しない。通常のIDB保存は引き続き列patch＋定期checkpointで、ページごとのIDB書込へは変更していない。

## cloneを伴う実行の比較

[計測器](../scripts/bench-row-store.ts) / [ブラウザworkload](../scripts/row-store-workload.ts)。同じartifact・保存画像で変更前後のJS / Wasmを動かし、100 / 1,000 / 5,000行と、100行＋無関係な5,000行を比較する。baseのPK索引をwarm-up後、毎回同じbaseをcloneして1行を実際に変更する。no-op UPDATEや、既に空になった行へのDELETEを繰り返す計測ではない。

各操作を約20msへ2回校正し、順序を変えて7サンプルを採る。候補は最後のものを保持して計時後に読み、JITから観測できる状態を保つ。nativeの型付き行hash、変更されないbaseとcold表、候補をSQLiteファイルへ出力した後のnative integrity / 行を計時前後に検査する。IDB・通信・RPC・Program読込を含まない。

変更前runtimeのSHA-256は、着手前に保存した[artifact記録](../measurements/p02-before/aot-current.json)と照合した。[全サンプル・retained versions・検証結果](../measurements/p02-row-store-paired.json)を保存する。通常の再採取は[現行のみの記録](../measurements/r02-before/row-store-current.json)へ書く。

Apple M5 / Chromium 158 / Node 24.22.2 / Moon 0.1.20261104 release。中央値、µs/操作。表のUPDATE / DELETEはcloneも含む。計測はengineごとの新しいcontextで逐次実行したもので、有意差検定や全端末の保証ではない。

| 対象行数 / cold表 | JS clone＋UPDATE 前→後 | Wasm 前→後 | JS clone＋DELETE 前→後 | Wasm 前→後 |
| --- | ---: | ---: | ---: | ---: |
| 100 / 0 | 14.24 → 3.83 | 5.20 → 2.90 | 13.33 → 2.77 | 4.27 → 2.17 |
| 1,000 / 0 | 117.83 → 3.75 | 26.35 → 2.93 | 122.57 → 2.85 | 26.75 → 2.14 |
| 5,000 / 0 | 581.06 → 3.89 | 112.68 → 2.90 | 605.16 → 3.04 | 116.69 → 2.14 |
| 100 / 5,000 | 13.28 → 3.75 | 4.70 → 2.92 | 12.79 → 2.78 | 4.01 → 2.16 |

1,000行のcloneのみはJS 0.16 → 0.21µs、Wasm 0.06 → 0.08µs。索引wrapperとページ所有の管理は増えるが、その後の更新で主キー索引を再構築せずに済む。1,000行のclone＋UPDATEは約31倍 / 9倍、DELETEは約43倍 / 13倍に短縮した。

### versionを保持するメモリ

別の計時外workloadで、同じbaseから更新した32個のcloneを保持した。warm済みbaseとmoduleを含むGC後baselineに対する追加heapと、採取中の同時刻heap＋backing合計の最大観測値を分ける。更新間でイベントループへ戻し、CDPで約2msごとに採取する。サンプルはgarbageも含み、同期処理の途中を取り逃し得るため、正確なピーク・RSS・Wasm code memory全体の上限ではない。

| 1,000行・32更新version保持 | 追加heap 前→後 | 最大観測合計 前→後 |
| --- | ---: | ---: |
| JS | 3,710.38 → 57.86 KiB | 10.67 → 6.46 MiB |
| Wasm GC | 2,929.93 → 50.18 KiB | 4.43 → 1.65 MiB |

このworkloadの追加backing storageは0 Bだった。5,000行では追加heapがJS 17,764.38 → 56.12 KiB、Wasm 13,965.93 → 53.95 KiB。1点の値からDB全体の定常メモリを一定とするものではなく、32世代が共有できる部分を増やした結果である。

### 実際の保存と配信

実IDB、1,000行、1行の整数列更新、strict ACKまでの7×32操作平均でcheckpoint込み。64 B TEXTの列差分は**0.327 → 0.196ms**、その準備部分は178.26 → 54.29µs。4 KiB TEXTでは0.411 → 0.315msとなった。CPUだけの31倍という倍率を、IDB待ちを含む保存時間へ適用しない。列patchの通常提出量465 B / 16行1,501 Bは[S01](column-delta.md)から変わらない。[TEXT](../measurements/r02-before/indexeddb-speed-current.json) / [BLOB](../measurements/r02-before/indexeddb-blob-current.json)を再採取した。

メモリDBの通常AOTベンチも比較した。1,000行のPK検索はJS 2.21 → 2.16µs / Wasm 1.70 → 1.67µs、UPDATEは5.30 → 4.61µs / 3.70 → 3.71µs。全行scanは878.18 → 938.46µs / 548.35 → 568.97µsで、同時採取のSQLiteも921.43 → 959.62µsへ変動した。scanの改善は主張しない。通常UPDATEの反復は同じ値への書込であり、上の「毎回cloneして実変更」とは区別する。[全SQL計測](../measurements/r02-before/sqlite-speed-current.json)。

AOTアプリのBrotli転送量は**107.51 → 111.49 KiB（+4,078 B）**。全APIを残す単体はJS 114.46 → 119.20 KiB（+4,846 B）、Wasm 143.13 → 148.69 KiB（+5,694 B）。永続vector / HAMTと所有管理の費用が増える。Litestream単体は変わらず、notes Programも20,049 B・SHA-256 `a6af7a52769d67773842aae483fcb856b46f628e31180d44afa14d2201bc2de2`で同一。[単体](../measurements/r02-before/wasm-build-size-current.json) / [アプリ](../measurements/r02-before/aot-current.json) / [機能別](../measurements/r02-before/sqlike-feature-profiles-current.json)。

```sh
just row-store-bench
just row-store-bench --before-js=/path/to/old/runtime.js --before-wasm=/path/to/old/runtime.wasm --output=measurements/p02-row-store-paired.json
just p0-measure
LITESTREAM_BIN=/path/to/litestream just check
just differential-audit
pnpm exec tsx scripts/check-p0.ts --record
```

## 検証範囲と残る費用

- [4実行経路とnativeの比較](../tests/paged-rows.test.ts): 1,000行のbulk削除、FK cascadeとtrigger、SAVEPOINT rollback、圧縮後のappend、主キー競合、保存画像への復旧を照合する。
- [実IndexedDB](../e2e/paged-rows.spec.ts): ページをまたぐ更新、700行削除、古いwriter、put後abort、再開とappendを検査する。既存のACK消失・offline再読込も通す。
- 主キー検索の全値・型・列順や、SQLite / LTX出力の検証は既存の厳密差分も継続する。未対応機能を一致へ合算しない。

MoonBit 49件×JS / Wasm、Node 259件、Chromium E2E 49件、型チェック・本家Litestream復元が通過した。厳密差分566ケース×8経路で不一致0、出力監査は各環境432一致・270 atomic拒否・誤出力0。source / artifactの鮮度を[完了証拠](../measurements/r02-before/p0-completion.json)で確認する。SQLite全機能互換の証明とは区別する。

全行は依然メモリに保持し、checkpointは全量JSON化する。cloneの保持や変更ページのコピーを減らした結果を、DB規模によらないメモリ上限や、checkpointの一時heapの解消へ読み替えない。SQLite writerの増分化と上限付きcacheはS02の別課題として残る。LSMは引き続き実験で、通常配信に含めない。
