# AOTの小さい変更で削れる範囲

2026-11-20（JST）。B03fに続いて、既存のwire形式とAPIを維持したまま、structのJSON readerとFROMなしの実行参照を小さくした。今回はこの範囲で区切る。

| engine単体 | minified JS: 前 → 後 | 削減率 | Brotli: 前 → 後 | 削減率 |
| --- | ---: | ---: | ---: | ---: |
| 最小SELECT | 279,898 → 269,205 B | 3.82% | 57,231 → 54,798 B | 4.25% |
| 最小CRUD | 346,601 → 341,255 B | 1.54% | 69,209 → 67,751 B | 2.11% |
| Vite既定のCRUD | 378,172 → 372,821 B | 1.41% | 74,380 → 73,030 B | 1.82% |

OXC minify、Brotli quality 11。host・catalog・Vite metadata・アプリコードを除く。最小CRUDのhost込みは343,042 B / Brotli 68,457 B。[変更前](../../measurements/aot-compact-before.json)と[現在の4構成](../../measurements/aot-minimum-current.json)を比較した。各minified engineとhostでint64のbindとCRUDをnative SQLiteに照合し、Brotliの復元結果も検査する。

## struct readerを共通化する

`Selection`、`Table`、`SchemaObject`、`Insertion`等のreaderを、既存のbinary wire宣言から生成する。JSON Tableに必要なsequence・sequence_present・rowsだけは、binaryのschema frameと異なる既存フィールドとして追加する。writerやprogram IDの生成規則は変えない。

各フィールドの値を一時変数へ保持し、最後に不足を調べるderiveの処理を、必須・optionalの共通取得関数へ置き換えた。単純にreaderを書き換えた時点では最小CRUDの削減はJS 1,935 B / Brotli 889 Bだった。フィールド取得も共通化すると5,346 B / 1,458 Bになった。

optional fieldは省略をNoneとし、存在するときは値を直接読む。明示nullを許可せず、未知のフィールドは従来どおり無視する。フィールド名が`fields`でもJSON objectの変数と衝突しない名前を使う。必須フィールド不足のエラーには該当keyのDecodeContextを付ける。

`json_struct_decode_wbtest.mbt`に従来のderiveを使うテスト専用の比較型を置いた。Table / Selection / SchemaObject / Insertionについて、各keyの省略・型違い・明示null・未知keyを作り、受理・拒否と、成功時の値の再シリアライズを比較する。これらの型は配布runtimeへ入らない。

## FROMがない場合のoptimizer参照を切る

source能力がfalseでも、prepare時のtable layout・point planと、実行時のpoint / simple scan / table集約への参照が残っていた。これらを`CAP_QUERY_SOURCE`の正の分岐からだけ呼ぶ。

既定の索引やoptimizerの設定は維持する。FROMを使うCRUDの検索経路は有効なままで、FROMを持たないqueryには到達しない実装を残さない。statementの実行と、ネストしたSELECTの実行の両方でpoint planの参照を切る。IN・subquery・window・aggregateの汎用評価は残す。

新しく計測した`select-vite-default`は、tableなしのbind付きSELECTにViteの既定索引・optimizerを選んだ構成。struct共通化の後、参照除去だけで317,999 → 288,715 B、Brotli 63,110 → 58,226 Bになった。これは参照除去の同条件比較で、上表の変更前からの全削減量とは異なる。[直前の4構成](../../measurements/aot-source-optimizer-before.json)。

## デコード速度の確認

```sh
just bench-json-structs
```

事前に解析したJsonから外側のstructを1件作るmicrobenchmark。両側のネストしたreaderは新実装で、SQLのparse・検証・実行やアプリ起動時間は含めない。release、各10サンプル、平均±標準偏差（ns、ツールの表示丸めあり）。[条件・source hash・範囲](../../measurements/aot-json-struct-bench.json)。

| backend / 対象 | derive | 小型reader |
| --- | ---: | ---: |
| JS / Table | 691.47 ± 33.34 | 671.71 ± 9.76 |
| JS / Selection | 1,210 ± 107.23 | 1,230 ± 73.02 |
| Wasm / Table | 764.89 ± 50.27 | 862.71 ± 217.81 |
| Wasm / Selection | 1,170 ± 67.19 | 1,210 ± 60.50 |

速度向上とは判断しない。Wasmでは平均が遅く、特にTableはばらつきも大きい。コードサイズと引き換えにロード時の小さなコストが出る可能性を残す。SQL評価のループ本体、数値変換とUTF-8処理自体の書き換えは含めていない。

## ここから先の費用

| 候補 | 見込める対象 | 費用と次の判断材料 |
| --- | --- | --- |
| [schemaの有無・制約ごとの除去（#7）](https://github.com/mizchi/sqlike/issues/7) | Table / SchemaObject codec、schema検証 | 中。reader・復元・制約検証を同じ能力で拒否する必要がある。削減量は未計測。 |
| [binary初期化と既存typed ABIの接続（#8）](https://github.com/mizchi/sqlike/issues/8) | Jsonのparse・変換と受け渡し | 大。初期化だけbinaryにしてもbind・結果がJSONならparserは残る。既存のnative ABIを使って全経路とJS / Wasmの差を評価する。 |
| [queryの形によるoptimizer選択（#9）](https://github.com/mizchi/sqlike/issues/9) | 使えない検索・scan・集約plan | 中。今回のsourceなしを越える選択には、5,000 / 100,000行での速度と容量の比較が必要。 |

最小CRUDとVite既定CRUDには、まだJSで約30.8 KiBの差がある。ただし任意の主キー索引とoptimizerの両方の費用を含む。まとめて切ると大きなtableの速度に影響するため、削減可能量とは扱わない。

この先は新しい能力分類や値受け渡しの契約を増やす範囲になる。まず今回の小型化を採用し、次回は対象アプリのqueryと規模が決まってから比較する。今回のサイズ差を速度改善やSQLite全機能の互換性として扱わない。

## 検証結果

`LITESTREAM_BIN=/path/to/litestream just check`が通過。Node 582件、MoonBit 96件×JS / Wasm、Chromium 73件、独立npm / Vite consumer、型チェックを検査した。SQLite出力監査はJS / Wasm / Chromiumで各508 probe一致・230 atomic拒否・成功出力の不一致0。未検証範囲は残る。

宣言グラフは125ノード・160辺のままZ3で再検証した。4種の現行サイズ・証明レポートとmicrobenchmarkのsource hashを照合し、独立に生成した最小CRUD engineの成果物hashも一致した。数値は英語・日本語READMEへ反映した。
