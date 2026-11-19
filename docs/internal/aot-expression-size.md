# AOTの式分類によるコード除去

2026-11-19。B03dの共有codec・集約検証の削減に続き、式の形をビルド時に収集した。既存のJSON／binary wire形式、program ID、文単位のrollbackは変更しない。

| エンジン単体 | minified JS: 変更前 → 変更後 | 削減率 | Brotli: 変更前 → 変更後 | 削減率 |
| --- | ---: | ---: | ---: | ---: |
| 最小SELECT | 317,834 → 300,762 B | 5.37% | 63,835 → 61,008 B | 4.43% |
| 最小CRUD | 373,203 → 356,104 B | 4.58% | 73,358 → 70,752 B | 3.55% |
| Vite既定のCRUD | 404,598 → 387,678 B | 4.18% | 78,611 → 75,912 B | 3.43% |

最小CRUDのhost込みは357,895 B／Brotli 71,378 B。数値はOXC minify、Brotli quality 11。catalog、Viteのclient metadata、アプリコードは含めない。実行速度の改善値ではない。

[変更前](../../measurements/aot-expression-before.json)、[関数呼び出しとsubqueryの切り分け後](../../measurements/aot-expression-call-subquery.json)、[この段階の3構成](../../measurements/aot-structure-before.json)に条件・定数・source hashを残した。B03d以前からの最小CRUDの変化は396,291 → 356,104 B、Brotli 75,790 → 70,752 Bである。

## 能力の契約

`src/runtime-capabilities.json`の`expressionGroups`を共通の宣言とする。

| 分類 | IR variant | ビルド定数 |
| --- | --- | --- |
| call | Call | CAP_EXPRESSION_CALL |
| subquery | InSelect / ScalarSelect / Exists | CAP_EXPRESSION_SUBQUERY |
| cast | Cast | CAP_EXPRESSION_CAST |
| case | Case | CAP_EXPRESSION_CASE |
| between | Between | CAP_EXPRESSION_BETWEEN |

`analyzeCatalogRequirements(source).expressionGroups`は、typed IRに現れた分類を重複なし・辞書順で返す。DDLのDEFAULT、CHECK、index、view、trigger、storage metadataと、実行されないCASEの枝も走査する。SQLらしい文字列literalは分類に影響しない。分類していない基本式やschemaの構造は汎用処理を残す。

JSON decoderとbinary readerは、無効な分類をfieldの読み込み前に拒否する。typed IRのFeatureCheckも同じ宣言から生成する。prepare／evaluateは正の定数分岐からだけ対象処理を呼び、不要な実装への参照を切る。CASTは通常評価とBoundExpressionの両方にgateを置く。ToJsonとbinary writerの表現は維持する。

LIKE演算子は関数呼び出しのCall nodeを持たないため、別に残す。LIKEの検証で汎用の関数名dispatcherを参照すると、関数を使わない構成にも分類器が残る。ここはLIKE能力を直接検査する。

## 依存グラフと実際のビルド

要求に現れた分類と、実装上の依存を閉じた選択は区別する。`expression/subquery`はSELECTへ依存し、`query/inSelect`はsubquery分類へ依存する。window機能には内部の関数評価が必要なのでcall分類を残す。

実際に出力する能力定数は、要求の配列ではなく`plan.constants`の閉包から取る。これにより、Call nodeがないwindow catalogでも、グラフが必要としたcall能力を出力できる。window用エンジンで通常の`count(*)` catalogも開けることをJS／Wasm、JSON／binaryで検査する。

通常SQLのbaselineと、catalog指定なしのビルドは5分類を有効にする。既存のfunction group、query part、optimizer、公開APIの選択は維持する。Viteの既定索引・optimizer設定も変更しない。

## 検証と次の候補

```sh
just explore-aot-size
just build-graph-check
LITESTREAM_BIN=/path/to/litestream just check
```

`tests/sqlike-expression-profile.test.ts`は5分類、LIKE、CTE、window、schemaのDEFAULT／CHECK、未到達のCASEを検査する。AOT／binary、JS／Wasmでnative SQLiteの結果と比較し、最小構成から関数評価・CAST評価・関数検証dispatcherが消えていることも確認する。必要な分類を含む別catalogを最小構成へ渡すと、接続作成時に拒否する。

全体の`just check`はNode 580件、Chromium 73件、MoonBit 93件×JS／Wasmを通過した。SQLite出力監査は各環境で508 probe一致・230 atomic拒否・出力不一致0で、未検証範囲は残る。windowから閉包へ追加されたcall能力の実行も、追加のJS／Wasmテストで確認した。Z3で121ノード・155辺の宣言された閉包を再検証した。この段階の検証はSQL全機能の同値性の証明とは区別する。最新のグラフと検証結果は[後続の構造分類](aot-structure-size.md)を参照。

全機能構成では5分類を有効にするため、この削減量をそのまま適用できない。再計測ではFullのminified JSは僅かに減り、Brotliは約0.17 KiB増えた。READMEには最小構成と全機能構成の両方の実測値を反映した。

未使用の式を切っても、SELECTのrelation生成、Selection／Tableのdecoder、数値変換とUTF-8検査は残る。次はtable参照やschema制約の有無を能力化する候補と、JSONを経由しない初期化を比較する。型の異なるbindやSQLiteの文字列変換があるため、number／text等を単純にデータ型名だけで削除しない。

後続の[FK・trigger readerとSELECT構造の切り分け](aot-structure-size.md)で、FROM・ORDER BY・DISTINCT・LIMITの未使用処理も除去した。
