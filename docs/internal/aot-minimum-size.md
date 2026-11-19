# AOT最小ビルドの削減調査

2026-11-19。Vite AOTの選択ロジックを含む、portable execute用の4 export構成を同条件で比較した。JSはOXCでminifyし、各ファイルをBrotli quality 11で圧縮する。以下はエンジン単体で、host・catalog・Viteの生成client・アプリコードを含まない。実行速度の測定ではない。

| 構成 | minified JS: 変更前 → 変更後 | 削減率 | Brotli: 変更前 → 変更後 | 削減率 |
| --- | ---: | ---: | ---: | ---: |
| SELECTのみ・追加optimizerなし | 345,072 → 317,834 B | 7.89% | 66,382 → 63,835 B | 3.84% |
| 最小CRUD・追加索引とoptimizerなし | 396,291 → 373,203 B | 5.83% | 75,790 → 73,358 B | 3.21% |
| Vite既定のCRUD・主キー索引とoptimizerあり | 427,685 → 404,598 B | 5.40% | 80,855 → 78,611 B | 2.78% |

最小CRUDのhost込みは398,080 → 374,994 B、Brotliは76,450 → 74,068 B。最小構成でも主キー制約、int64、文単位のrollbackを維持する。Vite既定の索引・optimizer設定は変更していない。

[変更前](../../measurements/aot-minimum-before.json)、[JSON関連の削減後](../../measurements/aot-minimum-decoders.json)、[この段階の結果](../../measurements/aot-expression-before.json)に、catalog・選択した定数・ソースhash・ツールの版と、大きい未minify関数を記録した。`crud-vite-default`はViteと同じエンジン設定であり、配信されるアプリ全体のサイズではない。続く[式の分類による削減](aot-expression-size.md)で、最小CRUDはさらに356,104 Bへ縮小した。

## 変更した部分

1. **関数能力の判定を直接Boolへ変換する。** 実行時の許可判定が、全関数名を関数群名の文字列へ変換してから定数へ変換していた。ビルド時の分類器は維持し、実行時は関数名から能力定数を直接参照する。`min/max`の引数1個と複数引数の区別も維持する。
2. **Expr / DataStatementのJSON decoderをwire契約から生成する。** 汎用deriveが、使わないINSERTやwindow等のfield decoderを到達可能にしていた。型・タグ・field順は既存のJSONと同じにし、無効なvariantはfieldを読む前に拒否する。ToJsonとprogram IDの計算は変更しない。不正なタグ・引数数・field型を拒否し、fieldのエラー位置はDecodeContext経由で残す。
3. **GROUP BYを独立した能力にする。** 集約関数を使わないGROUP BYもあるため、関数群だけでは集約の準備処理を外せなかった。typed IRから`query/groupBy`を収集し、必要なときだけ集約出力検証を参照する。通常SQLのbaselineでは従来どおり有効にする。

JSON関連の変更までで、最小CRUDは381,193 B / Brotli 74,507 B。GROUP BYと集約検証の分離を加えて373,203 / 73,358 Bになった。

今回のMoonBit出力では、条件付きearly returnの後ろに汎用の検証が残る場合があった。大きい検証を別関数へ分け、正の能力定数の分岐からだけ呼ぶ形にすると、link時に除去できた。テストは最終出力に不要な分類器・INSERT decoder・集約出力検証が残っていないことも確認する。

## まだ大きい部分

最小SELECTでも、未minifyの関数本体には次が残る。これは圧縮後の寄与ではなく、次に調べる場所を示す値である。

| 処理 | 未minifyの関数本体 |
| --- | ---: |
| 汎用SELECTのrelation生成 | 33,511 B |
| UTF-8の不正byte検出 | 22,329 B |
| 式の準備・検証 | 19,682 B |
| 汎用数値parserのunderscore検査 | 18,094 B |
| 削減後のExpr JSON decoder | 15,965 B |

JSONのparse / stringify、schemaのFromJson / ToJson、数値の文字列変換が共有されている。SQL JSON関数を無効にするだけではこれらは消えない。UTF-8の検査とSQLiteの数値変換は、非互換な成功出力を避けるために必要な経路も含む。

次の候補は優先順に以下とする。いずれもまだ削減量・速度を保証するものではない。

- [x] **式を能力として収集する。** 関数呼び出し・subquery・CAST・CASE・BETWEENの5分類をIRから追跡し、decoderとprepare / evaluateを一緒に外す。[結果](aot-expression-size.md)。
- [ ] **schemaの形を能力として収集する。** table参照・制約・metadataの必要性を追跡する。使用する構成のJS / Wasmと、未使用構成の読み込み拒否を検証する。
- [ ] **JSONを必要としない初期化経路を測る。** binary catalogまたはMoonBitの値を生成し、JSのtyped ABIと組み合わせた場合の総量を比較する。JSON parserだけでなくschema codec・program ID・型変換まで含めた比較が必要。
- [ ] **optimizerをqueryの形から選ぶ。** 既定CRUDと最小CRUDには約31 KiBの差があるが、索引とoptimizerをまとめた差であり、独立には足せない。不要な単純scan等を外す候補を、正常な検索・空振り・型の異なるbindの速度と比較する。

JavaScriptの`JSON.parse`や`Number`への置換は未実施。数値の元表現、int64、負のゼロ、program ID、SQLiteの文字列変換との整合を確認してから判断する。

## 再現と検証

```sh
just explore-aot-size
just measure-crud-size
just measure-entrypoints
LITESTREAM_BIN=/path/to/litestream just check
```

探索用スクリプトは、エンジンとhost込みの両方をminify後に読み込み、`node:sqlite`とSELECT / CRUDの結果を比較する。圧縮は展開後のbyte一致も確認する。既存のcatalog差分テストはJS / Wasm、GROUP BYのみのSQL、schema内の式、views、trigger、FK、無効なcatalogを検査する。Vite側はnpm tarball、dev / build watch、混在拒否と修正後の復帰を検査する。

この段階の`just check`はMoonBit 93件×JS / Wasm、Node 578件、Chromium 73件を通過した。出力監査は各環境で508 probe一致・230 atomic拒否・出力不一致0で、未検証の範囲は残る。`just build-graph-check`も通過し、当時のGROUP BYを含む116ノード・147辺の宣言された閉包をZ3で再確認した。これはSQL全体の形式的な同値性を証明するものではない。現行の121ノード・155辺の検証は[式分類の記録](aot-expression-size.md)を参照する。
