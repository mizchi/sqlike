# S01: 変更列だけの永続差分

2026-11-15、開発版0.0.1。SQLike / AOTの行ジャーナルに列patchを追加した。未変更の大きなTEXT / BLOBを更新ログへ入れず、checkpointは従来どおり全量で保存する。IDBのobject storeや公開関数の引数は変えていない。

このページの数値・JSONはS01完了時点を保存したもの。その後の行コンテナーは[P02](row-store.md)、現行の再計測とLTX送信は[R02](aot-ltx-upload.md)を参照する。

## 記録する範囲

[行の置換](../packages/sqlike/src/index_cache.mbt)で変更前後の値を比較し、[dirty状態](../packages/sqlike/src/persistence.mbt)へ変更列と新しい値だけを記録する。全DBをdumpしてからdiffを取る実装ではない。比較は格納型も区別し、REALはbit単位で比較する。変更のないValue参照は比較を短絡する。

変更後の値は不変で、patch配列も公開後は変更しない。古い行・Store・全量文字列をログ生成のために保持しない。列数に比例する比較と、小さなpatch配列の割当は増える。変更したTEXT / BLOB自体は列全体を保存する。変更対象表の行配列のcopy-on-writeと、全行のメモリ常駐は残る。

同じ値への更新でも、SQLのchanges・serial・triggerの動作は維持する。対象行の値とrowidが同一ならその行のeditだけを省き、metadataとtriggerが変更した行は記録する。INSERTは新しい行全体、DELETEはrowid、全列が変わった更新は行全体の置換を使う。編集順序を保ち、複数の更新を一つへまとめて中間状態を飛ばさない。

## 保存形式と互換性

| 形式 | 新producer | 新reader |
| --- | --- | --- |
| `sqlike-flush@1` / `full:true` | snapshotに使用 | 対応 |
| `sqlike-flush@1` / `full:false` | 生成しない | 旧after-imageログをreplay |
| `sqlike-flush@2` / `full:false` | 通常の増分ログに使用 | 対応 |
| `sqlike-flush@2` / `full:true` | 生成しない | 拒否 |

v2では既存の`AppendRow` / `ReplaceRow` / `DeleteRow`に、次のeditを追加する。列番号は0始まり、昇順・重複なし。rowidとINTEGER値の文字列はInt64を保持するための表現である。

```json
["PatchRow", "t", "500", "500", [[1, ["Integer", "1002001"]]]]
```

順に、表名・変更前rowid・変更後rowid・`[列番号, 格納値]`の配列。対象列以外は再生先の行から引き継ぐ。v1内の`PatchRow`は拒否する。`base`は直前ACKのserial、`serial`は更新後のserial。schema cookie、encoding、changes、last_rowid、FK設定、各表のsequenceも従来どおり記録する。

AOTの`aot-flush@1`はProgram IDとこのcore payloadを包む。`aot-journal@1`、`moon-aot-store@1`、IDB rootのformat 2と世代CASは変更しない。旧snapshot＋旧deltaから、新しいv2ログへ続けて再生できる。[旧producerから固定したfixture](../tests/fixtures/persistence/v1.json)で検証する。

旧runtimeはv2ログを読めないため、新しいproducerが書いた後の再開には新しいreaderが必要になる。読み違えて値を公開する代わりに、未対応のformatとして拒否する。

これは**同じcheckpointから世代順に再生するローカル永続ログ**であり、並行writerのmerge形式ではない。別DBでserialが等しいことを履歴一致の証拠にせず、同期側のrevision / 適用ポリシーと区別する。

## 適用・公開の検査

readerはbase / serial、schema、列番号の整数性・範囲・順序、行の存在、rowidとINTEGER PRIMARY KEYの整合、格納値、制約を検査する。patchから行を再構築し、既存の行検証とFK検査を通す。検査は候補Storeに対して行い、後半のeditが失敗しても先行した変更を公開しない。triggerや元のSQLは再実行しない。

JSONの標準Int32デコーダーが小数を切り捨てるため、増分ログの列番号・base / serial・cookie / changesは型変換前にも整数性を検査する。NaNの格納値をNULLへ暗黙変換せず拒否する。

保存の回帰テストで、旧実装がREALの負のゼロをsnapshot / deltaのJSON化で正のゼロへ変える不具合を修正した。`["Real","-0"]`タグで、AOTの入れ子JSONやホストのparse / stringifyを通っても符号を保持する。既存の数値REAL表現、Infinity / -Infinityタグも引き続き読む。過去に`0`として保存されて符号を失った値は、画像だけから復元できない。

ストレージはpayloadを解釈せず、世代CASとstrict IDB transactionのcomplete後にACKする。abort / stale writer / ACK消失時は接続を再開し、不明な結果の上へ次の書込を重ねない。128レコードまたは4 MiBで次回をcheckpointにし、checkpointと旧ログ削除は原子的に行う。

## 検証と計測

- [MoonBitの回帰](../packages/sqlike/src/column_delta_wbtest.mbt): 大きな未変更値の省略、同値更新、格納型と負のゼロ、snapshot / patchの往復。
- [形式の回帰](../tests/persistence-format.test.ts): JS / Wasmの動的 / AOTでv1→v2を再生。壊れた列番号、NaN、不正version、途中まで有効なログをatomicに拒否する。
- [既存のnative比較](../tests/persistence-delta.test.ts): 型・主キー更新・UPSERT・cascade・失敗後状態を照合する。
- [実IDBのE2E](../e2e/persistence-columns.spec.ts): 4 KiB BLOBと大きなTEXT、ACK待ちの公開、中断・ACK消失・stale writer、trigger / FK・savepoint rollback・130更新後のcompaction・再読込を検査する。

```sh
just indexeddb-bench
just indexeddb-bench --blob --output=measurements/indexeddb-blob-current.json
just p0-measure
LITESTREAM_BIN=/path/to/litestream just check
just differential-audit
pnpm exec tsx scripts/check-p0.ts --record
```

測定は固定SQL・同じ疑似乱数payloadでTEXTとBLOBを別々に採取する。1 / 16行更新、strict ACKまでの7×32操作の全サンプルを保持し、checkpointを除外しない。再開後の値はnative SQLiteの型付き結果と照合し、ページ方式のファイルもnative SQLiteで開く。提出量はIDBへ渡した値の量で、物理ディスクの書込量ではない。

変更前は[s01-before](../measurements/s01-before)、現行は[TEXT](../measurements/p02-before/indexeddb-speed-current.json) / [BLOB](../measurements/p02-before/indexeddb-blob-current.json)。全量snapshot・ページ方式も同時に再採取する。ページ方式は毎回全SQLite画像を再生成する比較用実装で、増分pagerやOSページとの比較ではない。

## 測定結果

Apple M5 / Chromium 158 / Node 24.22.2 / Moon 0.1.20261104 release JS。1,000行のうち整数列を更新し、payload列は変更しない。通常差分の提出量はTEXT / BLOBとも次の値になった。提出量にはAOTジャーナルのenvelopeも含む。

| 未変更payload | 更新行数 | v1 after-image | v2列patch |
| --- | ---: | ---: | ---: |
| 64 B | 1 | 608 B | 465 B |
| 64 B | 16 | 3,789 B | 1,501 B |
| 4 KiB | 1 | 4,640 B | 465 B |
| 4 KiB | 16 | 68,301 B | 1,501 B |

4 KiB列の通常差分は1行で90%、16行で98%減った。checkpoint込みの全224操作では、平均提出量は1行23,431 → 19,275 B、16行142,333 → 39,113 B。checkpoint回数は1行更新で1 → 1回、16行更新で4 → 2回だった。行ジャーナルの件数上限は変えていないが、4 MiBのbyte閾値に達しにくくなった。

strict ACKまでの平均、ms/操作。中央値の良いrunだけを抜き出さず、checkpointを含む全操作を使う。

| payload | 更新行数 | v1 → v2 |
| --- | ---: | ---: |
| 4 KiB TEXT | 1 | 0.403 → 0.411 |
| 4 KiB TEXT | 16 | 1.936 → 1.391 |
| 4 KiB BLOB | 1 | 0.759 → 0.702 |
| 4 KiB BLOB | 16 | 3.201 → 1.967 |

16行更新ではTEXTで28%、BLOBで39%短縮した。1行更新ではcheckpointの費用が支配的で、提出量の削減率がそのまま時間の短縮率にはならない。今回のTEXT 1行の平均は約2%増であり、改善として数えない。

小さい行の一部で平均時間が増えたため、変更前runtimeを別のsourceコピーで再生成し、P01完了時のSHA-256 **`1a78e8eacca74a28a83bffdf283b82a61673146112d8ae2e50bae4d1144f450a`**との一致を確認した。同じ計測器・100行 / 64 B TEXTで、前→後→後→前の順に採取した。各reportは7×32操作、表は各report平均の等重み平均。

| 小DBの交互比較 | v1 | v2 |
| --- | ---: | ---: |
| 1行更新・strict ACKまで | 200.68 µs | 196.88 µs |
| 同・準備部分 | 67.38 µs | 64.87 µs |
| 16行更新・strict ACKまで | 366.79 µs | 337.79 µs |
| 同・準備部分 | 219.63 µs | 192.49 µs |

この交互比較では小DBの退行は再現しなかった。全入力・全端末の保証や、有意差検定の結果ではない。[4回分の記録と集計](../measurements/s01-small-paired.json)、[旧sourceへの差分](../measurements/s01-before/source.patch)を保存した。交互比較後の変更はメモリprobeの位相調整で、計時用のSQL・runtime・checkpoint方針は変えていない。個別再現用のselectorは次の形で使える。

```sh
just indexeddb-bench --dataset=100-64 --strategy=semantic --runtime=/path/to/previous/runtime.js --output=/tmp/idb-before.json
```

## メモリとcheckpoint

全行を保持するため、定常メモリの大幅な削減はない。1,000行×4 KiBのGC後、初期化前baselineからの差は、v2のTEXTでJS heap **6.84 MiB** / backing **0.03 MiB**、BLOBで **6.98 MiB** / **3.93 MiB**。v1の同条件は6.87 / 0.03 MiB、6.94 / 3.93 MiBだった。BLOBのbacking storageをJS heapへ隠して足し合わせない。

差分が小さくなると、メモリ採取区間にcheckpointが入る位置も変わる。[自然な位相の診断](../measurements/s01-blob-memory-check.json)では、旧runtimeにcheckpointが入らず、新runtimeにだけ入った。これをメモリ増加の倍率と解釈しない。

現在のメモリ専用probeは**64更新の先頭で双方とも全量checkpointを要求**し、各書込のkind・提出量・時間も記録する。計時用の224操作は自然なcheckpoint時点を維持する。過去の位相が異なるpeakへ改善率を付けない。BLOBの全量checkpointを含むprobeでは、旧・新とも100 MiBを超える一時heapを観測する。この全量JSON化の費用は今回解消していない。[位相を揃えた旧runtime](../measurements/s01-before/blob-memory-matched.json) / [新runtime](../measurements/s01-blob-memory-matched.json)。

peakはCDPの約2msサンプリングによる同時刻のheap＋backing合計で、未回収のgarbageを含む。同期処理中のピークを取り逃す可能性があり、正確な上限・RSS・IDBサービスの保持量ではない。次のP02では変更表内のコピーを減らすが、checkpoint全量変換の改善も別途必要になる。

## 配信と回帰

AOT実アプリのBrotli転送量は**107.12 → 107.51 KiB（+396 B）**。全公開APIを残した単体はAOT JSで113.42 → 114.46 KiB（+1,070 B）、Wasm GCで141.65 → 143.13 KiB（+1,520 B）。Litestream単体は変わらない。notes Programも20,049 B・従来のSHA-256のまま。[実アプリ](../measurements/p02-before/aot-current.json) / [単体](../measurements/p02-before/wasm-build-size-current.json) / [機能別](../measurements/p02-before/sqlike-feature-profiles-current.json)。通常配信へのLSM / FTS混入は引き続き拒否する。

MoonBit **45件×JS / Wasm**、Node **258件**、Chromium E2E **48件**、型チェック・本家Litestream復元が通過。厳密差分566ケース×8経路で不一致0、出力監査も各環境432一致・270 atomic拒否・誤出力0。未対応機能を一致へ合算せず、SQLite全機能互換とは判定しない。
