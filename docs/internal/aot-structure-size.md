# AOTのschema decoderとSELECT構造の削減

2026-11-20（JST）。B03eの式分類に続き、FK・triggerのreaderと、FROM / ORDER BY / DISTINCT / LIMITの実装を切り分けた。JSONとbinaryのwire表現、program ID、文単位のrollbackは維持する。

| engine単体 | 変更前 JS / Brotli | FK・trigger除去後 JS / Brotli | SELECT構造の除去後 JS / Brotli |
| --- | ---: | ---: | ---: |
| 最小SELECT | 300,762 / 61,008 B | 297,364 / 60,517 B | 279,898 / 57,231 B |
| 最小CRUD | 356,104 / 70,752 B | 352,700 / 70,303 B | 346,601 / 69,209 B |
| Vite既定のCRUD | 387,678 / 75,912 B | 384,274 / 75,502 B | 378,172 / 74,380 B |

変更前からの削減率は最小SELECTがJS 6.94% / Brotli 6.19%、最小CRUDが2.67% / 2.18%、Vite既定CRUDが2.45% / 2.02%。OXC minify、Brotli quality 11。host・catalog・Vite metadata・アプリコードは別。最小CRUDのexecute host込みは348,388 B / Brotli 69,827 Bとなった。実行時間の改善値ではない。

[変更前](../../measurements/aot-structure-before.json)、[FK・triggerの変更後](../../measurements/aot-schema-decoders.json)、[この段階の結果](../../measurements/aot-compact-before.json)に各段階の設定・定数・source hashを残す。過去snapshotのhashは、その段階のソースを表す。

## 1. FK・triggerを読み取る前に分岐する

従来は`ForeignKey`と`TriggerDefinition`のフィールドをデコードしてからfeatureの有効性を調べていた。このため、使わないruntimeにもフィールドのJSON decoderが残っていた。

`FEATURE_FOREIGN_KEYS` / `FEATURE_TRIGGERS`の正の分岐からだけ専用のJSON readerを呼ぶ。binary readerも同じ位置で分岐する。生成元は既存の`src/binary-wire.json`で、writer、タグ、フィールド順は変更しない。非対応の構成は読み込み時に拒否する。

structのoptional fieldは、省略でNone、存在すれば値を直接デコードする。enumの位置引数にあるOptionの配列表現とは異なるため、既存のderiveと同じ規則を生成する。明示nullは許可しない。欠けた必須フィールドや異なる型はDecodeContextの該当keyで失敗する。

## 2. SELECTの構造から処理を選ぶ

`src/runtime-capabilities.json`のquery partを4つ追加した。

| query part | typed IRでの判定 | 除外する処理 |
| --- | --- | --- |
| source | sourcesが空でない | FROMのscope解決・行展開・Source decoder |
| orderBy | ordersが空でない | 最終出力のsort key・collation算出・ソート |
| distinct | distinctがtrue | SELECT出力の重複検査 |
| limitOffset | limit / offsetが標準の-1 / 0以外の式 | LIMIT / OFFSETの評価・変換・出力範囲の選択 |

sourceは物理tableだけでなく、view・CTE・派生table・table functionのFROM参照を含む。JOINはsourceへ依存する。schemaにtableがあるだけでは、FROMを使うとは判定しない。viewやtrigger本体、未到達のsubqueryもtyped IRの走査対象にする。SQLらしい文字列は判定しない。

同じ事実抽出をcatalog解析と読み込み時の検証に使う。必要なquery partを持つ別catalogは、能力を欠くruntimeの接続作成時に拒否する。JSONとbinaryの双方に適用する。通常SQLのbaselineとcatalogなしのビルドは4項目とも有効にする。Vite側で利用者がflagを指定する必要はない。

window内のORDER BYは最終出力のorderByから独立する。orderByを除外しても、windowが必要とするソートは残す。UNION / INTERSECT / EXCEPTが行う集合演算も、SELECT DISTINCTとは別に維持する。既定の索引・optimizer選択は変更しない。

## 検証

```sh
just explore-aot-size
just build-graph-check
LITESTREAM_BIN=/path/to/litestream just check
```

`sqlike-schema-codec-profile`は不要readerの除去、複合FKの更新・削除CASCADE、deferred制約、triggerをAOT / binary・JS / Wasmで照合する。MoonBitのwhiteboxテストではoptional fieldの往復と不正入力を検査する。

`sqlike-query-profile`は4項目の推論・実コード除去・異なるcatalogの拒否に加え、NOCASE、NULL順序、DISTINCT、bindしたLIMIT / OFFSET、EXISTS、compound、viewを本家SQLiteと比較する。optimizerあり・なしを両方検査する。`sqlike-expression-profile`は最終orderByなしのwindowソートも確認する。

追加テストで、SQLiteがEXISTS内の非ゼロ小数LIMITを1へ書き換えるケースも確認した。sqlikeは従来どおり非整数LIMITを明示拒否する。この成功範囲は今後の互換機能拡張に残す。

宣言グラフは125ノード・160本のrequires辺。Z3の閉包検証は通過した。[記録](../../measurements/sqlike-build-graph-proof.json)。これはSQL意味論や未宣言の内部依存の証明とは区別する。

全体検証ではNode 582件、MoonBit 95件×JS / Wasmが通過。Chromiumは73件中71件が通過し、残り2件はquery partの期待値に新しい分類を含めていないため失敗した。期待値を更新し、その2件の実行・IndexedDB offline再開が通過したことを再確認した。型チェックと、現在の4計測レポートのsource hash照合も通過した。

その後の`just sqlite-output-check`も通過。JS / Wasm / Chromiumそれぞれで508 probeの出力が一致し、230件を原子的に拒否、成功した出力の不一致は0。未検証範囲を含むため、SQLite全機能互換の判定は引き続き未達とする。

## 残る候補

Table / SchemaObject / Selectionの汎用decoderは残る。schema制約そのものの有無の分類、binary / 値生成による初期化と既存typed ABIの接続、queryの形によるoptimizer選択を次の候補とする。数値変換とUTF-8処理を単純に置換する変更は含めない。

全機能構成では4項目を残す。今回の再計測ではFullのJS / Brotliはわずかに減ったが、全SQL実行機能AOTのBrotliは124.00 → 124.08 KiBとわずかに増えた。小さい構成の削減率を全構成へ当てはめない。[全entryの実測](../../measurements/sqlike-entrypoints-current.json)。

後続の[struct decoder共通化とFROMなしoptimizerの除去](aot-compact-size.md)で、同じwire形式のままさらに小型化した。
