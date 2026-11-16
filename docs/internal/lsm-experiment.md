# MoonBit LSM 実験

`just lsm-bench` で IndexedDB 上の ordered KV を比較する。SQL 実行器へ接続する前に、全件をメモリに保持する行ジャーナル方式と LSM の保存・復旧・読み込みの差を確認するための実験である。**実験専用として保ち、デフォルトには採用しない**。SQLike / AOT は既存の行ジャーナル方式を使う。

LSM のコード・生成物は通常版・lite版・Worker の配信バンドルから除外し、通常のバンドルサイズにも含めない。Vite のページ側・Worker 側に[混入を拒否する build plugin](../../scripts/production-boundary.ts)を設定する。`just lsm-bench` と LSM のテストは別のビルド経路を使い、LSM 単体のサイズは本レポートと専用の計測 JSON にのみ記録する。`moon build` が `_build` に LSM を生成しても、それを配信対象へ追加しない。

## 実装の境界

- [`mizchi/sqlike/lsm`](../../packages/sqlike/src/lsm/lsm.mbt): MoonBit の sorted block、二分探索、after-image の merge、tombstone、CRC32 付きバイナリ形式。SQL パーサ、SQLite ファイル処理、JS FFI には依存しない。
- [`OrderedKv` / `LsmStorage`](../../src/lsm-contract.ts): 論理操作とインフラの契約を分離する。キーは符号付き int64、値は任意の bytes、`null` は削除、空の bytes は値である。SQLite の全型・collation・複合キーの順序互換性はこの契約の対象に含めない。
- [`LsmDatabase`](../../adapters/lsm-database.ts): 非同期のブロック読み込み、サイズ制限付き memtable、段階 compaction、snapshot と LRU。MoonBit のブロックを操作するホスト実装で、非同期スケジューラは TypeScript。
- [`IndexedDbLsmStorage`](../../adapters/lsm-indexeddb.ts): 不変ブロック、WAL、manifest、世代 CAS を保存する。別のインフラは同じ契約で注入でき、Node のテストでは IndexedDB / Worker なしのメモリ provider を使う。

```text
writeBatch(full after-images)
  → sorted binary WAL batch + generation CAS を strict transaction で確定
  → ローカルの memtable を公開
  → 閾値で immutable sorted run を作成
  → 同じ level の4 run を次の level に streaming merge

get / bounded scan
  → memtable / sparse block index
  → 必要な IndexedDB block だけ取得
  → 最新 sequence を選択し、tombstone を除く
```

通常の書き込みは manifest 全体を読み書きしない。小さな `head` と `wal` を更新し、run の変更時だけ別の `manifest` record を更新する。既定の memtable / WAL 閾値は64 KiBまたは128 WAL records、ブロック目標は16 KiB、キャッシュの計上上限は256 KiB、fanout は4。単一 batch は最大1 MiBで、閾値を超える最後の batch は受け入れてから flush するため、64 KiBはプロセス全体や瞬間使用量のハード上限ではない。

```ts
import { LsmDatabase } from "./adapters/lsm-database.ts";
import { IndexedDbLsmStorage } from "./adapters/lsm-indexeddb.ts";

const db = await LsmDatabase.open(await IndexedDbLsmStorage.open("demo"));
await db.writeBatch([{ key: 1n, value: new TextEncoder().encode("one") }]);
const before = db.snapshot();
await db.writeBatch([{ key: 1n, value: null }]);
console.log(await db.get(1n));     // undefined
console.log(await before.get(1n)); // bytes for "one"
before.close();
db.close();
```

## 適用と回復

ブロックは UUID をキーに `add` で保存し、上書きしない。flush / compaction は新しい出力ブロックを先に保存し、最後に manifest と generation を CAS で公開する。flush では同じ transaction で WAL を消去する。途中で失敗したブロックは新しい root から見えず、直前の root / WAL から再開する。

書き込み中の失敗や ACK 消失後は、そのハンドルからの継続を拒否し、reopen を要求する。最後の batch は確定済みの可能性があるので、エラーを未適用とみなして自動再送しない。同じ root を開いた複数 writer のうち、古い generation の公開は拒否する。複数 writer の書き込み内容を自動 merge するプロトコルではない。

各ハンドルは open 時の root と自分で確定した更新を参照する。別接続の更新を自動監視せず、新しい root を読むには reopen する。

WAL が上限に到達してから flush が中断した状態も復旧対象とする。reopen 後の最初の書き込みは、残った WAL を先に flush し、次の batch を新しい sequence で保存する。入力を呼び出し時に捕捉するため、待機中に利用者が `Uint8Array` を書き換えても保存結果は変わらない。

snapshot は不変の root と memtable を保持する。別接続が compaction しても古いブロックを読めるよう、この実験では退役ブロックと中断時の orphan を削除しない。通常の段階 compaction は tombstone を残す。明示的な `compact()` は現在の全 run を merge し、tombstone を除ける。

## 比較方法

[`bench-lsm.ts`](../../scripts/bench-lsm.ts) / [`lsm-bench-workload.ts`](../../scripts/lsm-bench-workload.ts)、全サンプルは [`measurements/lsm-current.json`](../../measurements/lsm-current.json)。同じ MoonBit release JS codec、int64 キー、INTEGER 8 bytes と疑似乱数 payload の full after-image を両方式へ与える。

比較相手の `JournalKv` はベンチ専用の参照実装で、全件を同じ MoonBit sorted block に保持する。通常は同じバイナリ batch を既存の `MoonImageStore` へ保存し、128 records / 4 MiB で全量の base64 snapshot にする。既存 SQLike の SQL 評価・制約検査・outbox は含まない。以前の SQL / ページ差分のベンチ結果と速度比を直接比較しない。

100 / 1,000 / 5,000行×64 bytes と、1,000行×4,096 bytes。各 workload は warmup 2回と7回×64 samplesで、点更新、隣接16行更新、点検索、16行範囲検索を測る。点・範囲検索はキーをデータ全域へ動かす。点検索だけは timer の量子化を減らすため1 sample内で16回を平均するため、その p99 は16回平均の p99である。更新と範囲検索の sample は各1操作。

全書き込みは strict IndexedDB transaction の完了までを含む。自動 flush / compaction の遅い sample を除外しない。最後の drain は別計測する。初期状態、各 workload 後、reopen 後、drain 後の順序付き INTEGER / BLOB 結果を native SQLite の SHA256 と一致させる。入力と source / runtime の hash も記録する。

workload 間で reopen し、起動は manifest と上限付き WAL だけを読む。reopen の時間は最初の SST block 読み込みを含まない。無限範囲の検証 scan はキャッシュ追加を避け、点検索と範囲指定 scan が256 KiBの LRU を共有する。

## 2026-11-15 の計測結果

Apple M5 / Chromium 158.0.8127.18 / Node 24.22.2 / Moon 0.1.20261104。32 groups、14,336 timing samplesを保持した。点検索は16回平均なので、実際の計測操作数は更新7,168回、点検索57,344回、範囲検索3,584回。各 group の型付き状態・replay は native SQLite と一致した。

更新は自動 compaction を含む平均 ms/op、検索は平均 μs/op。

| 行数 / payload | 方式 | 1行更新 ms | 16行更新 ms | 点検索 μs | 16行検索 μs |
| --- | --- | ---: | ---: | ---: | ---: |
| 100 / 64 B | 全件保持 journal | 0.132 | 0.168 | 0.8 | 6.5 |
| 100 / 64 B | LSM | 0.146 | 0.169 | 1.3 | 23.1 |
| 1,000 / 64 B | 全件保持 journal | 0.161 | 0.247 | 0.6 | 7.2 |
| 1,000 / 64 B | LSM | 0.296 | 0.218 | 2.0 | 23.2 |
| 5,000 / 64 B | 全件保持 journal | 0.326 | 0.302 | 0.8 | 6.8 |
| 5,000 / 64 B | LSM | 0.255 | 0.260 | 50.6 | 182.7 |
| 1,000 / 4 KiB | 全件保持 journal | 0.511 | 1.599 | 1.4 | 12.4 |
| 1,000 / 4 KiB | LSM | 0.640 | 4.853 | 184.3 | 1,405.4 |

5,000行の点更新は約22%短くなった一方、小さいデータの優位性はない。大きな値を更新する条件では LSM の読み書きと compaction が重い。1,000行×4 KiB の16行更新は平均1.599 → 4.853 ms、p99 は47.05 → 19.55 ms、最大は49.09 → 160.76 msだった。頻度の低い大きな compaction は p99 にも表れないことがあるため、平均・p99・最大を併記する。単一マシンの連続実行であり、個々の速度差には揺れがある。

同じ大きな値の16行更新で、計測区間の平均投入量は journal 約135.4 KiB/op、LSM 約214.6 KiB/op。LSM は毎回64 KiB前後の batch で flush し、複数の出力ブロックを別々の strict transaction で保存する。ブロック単位の IO に加えて merge / codec の CPU もかかるため、書き込み量やトランザクション数の削減が次の検証候補となる。

範囲検索後、キャッシュを保持した状態での基準ページからの差（MiB）は次の通り。

| 行数 / payload | 方式 | JS heap | backing storage | 合計 |
| --- | --- | ---: | ---: | ---: |
| 5,000 / 64 B | 全件保持 journal | 1.169 | 0.343 | 1.512 |
| 5,000 / 64 B | LSM | 1.053 | 0.207 | 1.260 |
| 1,000 / 4 KiB | 全件保持 journal | 0.584 | 3.914 | 4.498 |
| 1,000 / 4 KiB | LSM | 0.691 | 0.260 | 0.951 |

大きい値の保持量を約79%減らせた。小さい値では index / iterator / JS object の比率が大きく、1,000行×64 Bでは LSM の保持量がむしろ増えた。全データをメモリに持たずに読める利点はあるが、「常に小さく速い」とは言えない。

1,000行×4 KiB の最終状態は live run 約4.37 MiBに対し、退役ブロック込み約57.38 MiB、5,294 recordsを残した。物理 GC なしで常用する段階にはない。

| サイズ対象 | raw | gzip | Brotli |
| --- | ---: | ---: | ---: |
| LSM + IndexedDB host の minified JS 単体 | 43.08 KiB | 10.90 KiB | 9.66 KiB |
| MoonBit core 全 API の JS（未 minify） | 63.47 KiB | 9.21 KiB | 8.03 KiB |
| MoonBit core 全 API の Wasm GC | 14.77 KiB | 6.62 KiB | 5.76 KiB |

Wasm は codec/core のみで、非同期 host / IndexedDB bridge を含まない。LSM は別パッケージなので、既存 SQL / AOT / LTX のランタイムと notes の compiled artifact の hash は変わっていない。上記9.66 KiBを既存アプリへ追加済みという意味でもない。

当面の判断は、**既存の行ジャーナルを維持し、LSM はメモリ制約が強い構成の候補として残す**。次はブロック保存の transaction 集約、compaction で大きい未変更 payload を繰り返し運ばない形式、reader を保護した物理 GC、遅延 index を順に検討する。SQL へ接続する判断には、これらに加え SQLite / LTX 生成時の全量バッファと一時メモリも含めて再計測する。

## メモリと未実装範囲

Chrome CDP の GC 後 `usedSize` と `backingStorageSize` を分けて記録する。`warm` は範囲検索後でキャッシュを保持、`retained` は reopen 後でキャッシュなし。基準ページからの差を比較する。これらは保持量の観測であり、compaction の瞬間ピーク、ブラウザ RSS、IndexedDB サービスの使用量ではない。

キャッシュ予算は encoded bytes による計上で、JS object overhead を含まない。memtable 以外にも、ブロック index を含む manifest、run ごとの iterator、compaction 入出力、利用者が保持する snapshot と返り値が必要になる。manifest は現状、全 sparse index をメモリへ読むので、DB サイズと完全に独立したメモリ上限は実現していない。

物理 GC は未実装で、ディスク使用量は更新に伴って増える。ベンチの `disk` は退役 / orphan を含む IndexedDB block record の総 bytes、`liveRunBytes` は現在の root が参照する量であり、OS の実書き込み量やディスク占有量の計測ではない。

試作のリソース上限は value 1 MiB、batch 1 MiB、1 block 65,536 entries / 4 MiB、root 65,536 blocks / 256 runs / manifest 16 MiB。generation は正の31bit整数で、通常の更新に加えて公開・compaction でも進む。上限に達したときは拒否し、切り詰めや既存状態の上書きをしない。長期運用向けの形式拡張・GC・移行手順は今後の課題。

SQLike の `Table.rows` / 二次索引・SQLite writer / LTX は、この ordered KV へまだ接続していない。LSM run は SQLite page ではないため、LTX にそのまま送れない。接続時は SQL の遅延 get / scan / writeBatch、二次索引、snapshot 整合性を実装し、SQLite 画像を生成する既存 writer との境界を残す必要がある。

## 検証と再実行

```sh
just lsm-bench --smoke
just lsm-bench
pnpm exec playwright test e2e/lsm.spec.ts
LITESTREAM_BIN=/path/to/litestream just check
```

MoonBit JS / Wasm GC で同じ固定バイナリを生成・読取し、破損や重複・順序不正を拒否する。[Node テスト](../../tests/lsm.test.ts)は native SQLite とのランダム差分、int64 両端、削除・再挿入、空値、batch atomicity、snapshot、stage / 公開失敗、ACK 消失、古い writer、破損ブロック、WAL 上限での復旧を扱う。[実ブラウザ](../../e2e/lsm.spec.ts)では IndexedDB の中断、再読込、別接続での compaction と pinned reader、入力 buffer の捕捉を検証する。

既存機能を含む検証は MoonBit **33件×JS / Wasm GC**、Node **147件**、Playwright **41件**が通過。型チェック、production build と本家 Litestream による LTX 復元も通過した。ベンチ専用 journal の replay 後の drain は[独立した回帰テスト](../../tests/lsm-bench.test.ts)でも確認する。
