# P0の実施結果とP01着手前の計測基準

2026-11-15。出力互換方針を適用した0.0.1で、V01（再計測）、C01（生成差分）、R01（組合せ受入）を実施した。完了判定は[チェックリスト](status-and-improvement-plan.md)と`just p0-check`で管理する。SQLite全機能の互換性証明や公開の記録とは区別する。

このページの数値とJSONはP0完了時点を保存したもの。P01実施後の現行値・差分は[P01の結果](p01-aot-results.md)を参照する。

## 実施内容

- V01: SQL・strict IDB・実アプリ配信・機能別サイズ・DO・index/triggerありなしの計測用アプリを逐次採取。ソースとartifact hashを記録し、古い結果を現行として使うことをcheckerで拒否する。旧値は[固定した基準](../measurements/p0-before)に保存した。
- C01: 3 seed × 9 family × 12組の324ケースを追加。元の26ケースと合わせ、成功が必須のケース・拒否が必須のケース・状態観測を動的/AOTのJS/Wasmで比較する。Chromiumの全機能台帳にも含めた。
- R01: [共通アプリschemaと必須プロファイル](release-acceptance.md)でU01〜U09を検査。SQL/binary同期、IDB中断・ACK消失・offline再読込、SQLite/native integrityと実Litestream復元をつなげた。

受入で見つけた列名変更の不具合を修正した。`ON UPDATE CASCADE`をDMLのUPDATEとして扱わず、triggerの`BEGIN`等をcase-insensitiveに解釈する。別表へINSERTする列と`new`/`old`参照を混同しない。[最小回帰](../tests/sqlike-migration.test.ts)と共通シナリオに固定した。

生成差分は、Chromium監査のbind encoderがJSONで`-0`を`0`へ変える問題も検出した。入力生成を共通`aotBindings()`へ統一した。レポートの入力もint64と特殊REALをタグで保持し、差のあった入力を失わない。テストの除外は追加していない。

## SQL実行

Chromium 158 / Apple M5 / memory DB、1,000行、7サンプル中央値、µs/操作。SQLikeはAOT、SQLite WASMはprepared再利用。JSON・型取得を含み、IDB・Worker RPC・通信を含まない。前回と今回の生値を併記し、差を全てコード変更の効果と断定しない。

| 操作 | JS 前回→今回 | Wasm 前回→今回 | SQLite 前回→今回 |
| --- | ---: | ---: | ---: |
| 主キー検索 | 4.83 → 5.25 | 4.76 → 5.10 | 1.39 → 1.50 |
| 主キーmiss | 3.71 → 3.99 | 4.13 → 4.35 | 0.46 → 0.53 |
| LIMIT 10 | 13.70 → 15.04 | 10.13 → 10.66 | 9.31 → 9.82 |
| SUM＋COUNT | 18.26 → 19.21 | 11.52 → 11.78 | 21.47 → 22.69 |
| 1行UPDATE | 5.46 → 5.54 | 3.80 → 3.86 | 1.27 → 1.31 |

[全行数・dynamic経路・cold表・CPU profile](../measurements/p01-before/sqlite-speed-current.json)。単純集約の結果をJOIN/GROUP BYへ一般化しない。PK検索はSQLite比で依然約3.5倍、missにも固定費が残る。P01ではprepared状態と境界処理の再利用を計測して判断する。

## strict IndexedDB保存

同じ1,000行・1行更新、7×32操作の平均、ms/操作。checkpointを除外しない。ページ方式は全SQLite画像を再生成してから差分を取り、増分pagerやOS物理ページとの比較ではない。

| payload/行 | 全量snapshot | 行after-image | ページ差分 |
| --- | ---: | ---: | ---: |
| 64 B | 1.713 | 0.332 | 5.727 |
| 4 KiB | 15.243 | 0.409 | 50.601 |

### メモリの区別

1,000行×4 KiB payload。GC後は初期化前baselineとの差、観測最大はbaselineを引かない同時刻のJS heap＋backing storage合計。別の64更新でサンプリングし、時間測定へ混ぜない。**サンプリング値は未回収のgarbageも含み、観測の間の一時ピーク・RSS・IDBサービスのメモリまでは測らない。** preparedは保存直前の保持、afterはcommit後のGC値である。

| 方式 | prepared heap | after heap | after backing | 観測最大合計 | 採取数 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 全量 | 18.85 MiB | 10.72 MiB | 0.03 MiB | 245.32 MiB | 134 |
| 行差分 | 6.99 MiB | 6.87 MiB | 0.03 MiB | 16.83 MiB | 12 |
| ページ差分 | 6.95 MiB | 6.84 MiB | 8.33 MiB | 215.92 MiB | 70 |

[全データとtimestamps](../measurements/p01-before/indexeddb-speed-current.json)。JS heapとbacking storageの個別最大を足して同時ピークにしない。保持メモリは実行段階やGCで変わるため、1点の差だけで定常上限を主張しない。全行保持、変更表のO(N)コピー、大きい未変更列の再保存は引き続きS01/P02/S02の対象である。

## 配信とエンジン単体

実アプリは新しいブラウザ・空の保存領域で各3回。Brotli quality 11、HTTP body合計で、page・Worker・precache・Program・選択SDKを含む。単体の全exportサイズとは合算しない。

| アプリ | 前回 | 今回 |
| --- | ---: | ---: |
| SQLike AOT | 105.11 KiB | 106.98 KiB |
| SQLike SQL文字列 | 161.99 KiB | 163.77 KiB |
| SQLite WASM | 474.54 KiB | 474.83 KiB |
| Turso WASM | 3.63 MiB（以前の採取） | 3.63 MiB |

[実アプリ](../measurements/p01-before/aot-current.json)・[全SDKと保持メモリ](../measurements/p01-before/runtime-current.json)。SQLikeに任意のFTS/LSMを含めない。notes Programは20,049 B、SHA-256も従来と同一。

| ライブラリ全公開API | JS Brotli | Wasm Brotli | JSの前回差 | Wasmの前回差 |
| --- | ---: | ---: | ---: | ---: |
| AOT＋SQLite writer＋LTX | 113.73 KiB | 141.58 KiB | +2.41 KiB | +2.85 KiB |
| SQLike dynamic SQL | 121.08 KiB | 153.32 KiB | +1.98 KiB | +2.58 KiB |
| Litestream | 41.86 KiB | 48.78 KiB | 0 | 0 |

[単体サイズ](../measurements/p01-before/wasm-build-size-current.json)・[静的な機能選択](../measurements/p01-before/sqlike-feature-profiles-current.json)。Wasmは非圧縮で小さくてもBrotli配信ではJSより大きい。配信境界と選択機能を固定して比較する。

## index・triggerの組合せ費用

同じ100行・64 B BLOBの計測用アプリ。plainは二次index・部分/式UNIQUE・triggerを除き、双方にPK索引・STRICT/FKは残す。HTML・runtime/IDB adapter・Program JSONをBrotliで実配信した。通常デモのWorker構成とは別のmain-thread測定で、RPC・同期通信を含まない。

| 構成 | 配信合計 | point read中央値 | durable title更新中央値 | 更新後保持heap差 |
| --- | ---: | ---: | ---: | ---: |
| plain | 117.52 KiB | 119.50 µs | 316.00 µs | 2.22 MiB |
| indexed-trigger | 118.82 KiB | 120.50 µs | 856.00 µs | 2.54 MiB |

triggerありでは監査行が増え、その追加書込とcheckpoint費用も含む。durable更新が遅いことを単なる実装overheadへ読み替えない。検索は同じPK lookupであり、feed index自体の改善倍率の測定ではない。各sampleでnative結果とIDB reopen後を照合した。[生データとメモリsample](../measurements/p01-before/release-app-current.json)。

## DOの型保持費用

実workerdのSQLite DO、1,000行、各7×10,000操作の中央値。時計はms分解能で、HTTPとsetupを時間から除く。raw APIはINTEGER/REALを区別できないため、同じ出力契約を持つ代替実装として扱わない。

| 操作 | raw µs | typed adapter µs | raw→typed SQL回数 |
| --- | ---: | ---: | ---: |
| PK lookup | 2.50 | 16.00 | 1 → 2 |
| REAL bind×2 | 2.50 | 22.50 | 1 → 4 |
| 同じ値へのUPDATE | 2.20 | 4.70 | 1 → 1 |

metadata取得＋typed取得の2回、REAL bindの型確認の追加2回が固定費になる。DOの保持メモリは測っていない。[ソースhash・全sample](../measurements/p01-before/do-speed-current.json)。

## 継続する検査

```sh
just p0-measure
LITESTREAM_BIN=/path/to/litestream just p0-check
pnpm exec tsx scripts/check-p0.ts
```

`p0-check`は既存回帰・出力互換・厳密差分を通してから、現行hashと完了証拠を記録する。次はP01/S01/P02を、この基準と局所profileで費用対効果を比較して選ぶ。LSMは実験のまま通常バンドルから除外する。
