# 通常式PK検索・JSON集約・型付きAOT（未リリース）

2026-11-18。次の3件を、失敗する回帰から実装した。

- [x] 通常式のprojectionでもPK候補を先に絞る
- [x] JSON tableの単純集約で展開行・JSONB配置用の補助木を保持しない
- [x] JS / AOTの型付きbind・結果を公開adapterとnpmの独立entryへ組み込む

## 通常式のPK検索

`SELECT n*2, upper(s) FROM t WHERE id=?`等に、既存の`BoundAccess` / `BoundExpression` / `BoundProjection`を使う。動的SQL、接続内prepare、JSON AOT、binary定義のJS / Wasmで、rowidまたは完全な主キーから候補を取得してから元のWHEREを再評価する。scalar関数等の汎用式は、選ばれた行だけのenvironmentを遅延生成する。Programに行・bind・Storeを保持しない。

集約・window・subqueryを含むprojection、DISTINCT / GROUP BY / HAVING / CTE、一般のORDER BY式等は既存経路を使う。LIMIT / OFFSETの対応外の格納クラスも既存の検査へ戻す。索引を無効にした構成では、同じキー探索契約の線形経路を使う。式索引・一般JOINの探索まで拡張したものではない。

[実行計画の回帰](../../packages/sqlike/src/full/bound_plan_wbtest.mbt)と[6経路の差分](../../tests/sqlike-point-projection.test.ts)で、複合WITHOUT ROWID主キー、collation、型切替、残余条件、BLOB、scalar式、live update、LIMIT / OFFSET、集約・window等のfallbackを検査する。

## JSON tableの単純集約

単一の`json_each` / `json_tree`に対するCOUNT / SUM / TOTAL / AVGを対象とする。引数は対応する直接列・literal・COUNT(*)で、WHERE・JOIN・GROUP BY・DISTINCT・FILTER・ORDER BYのない形。`atom` / `value` / `key` / `type`・hidden入力とrowidは対応し、ID・parent・pathが必要な場合は従来の展開器へ戻す。

JSON DOMは入力全体を解析する。集約専用のvisitorは、13個のBindingを持つ行environmentとJSONB配置用の補助木を作らず、必要な値を既存のSumStateへ渡す。型・overflow・補正和を共有し、JSON入力・node / 深さ・path byte数・行数の上限も検査する。定数メモリのJSON parserや全queryのstreaming化ではなく、peak memoryの削減率は未計測。

[回帰](../../tests/sqlike-json-table-stream.test.ts)は、通常展開に戻る`WHERE 1=1`も含め本家と6経路で照合する。NULL・空集合・scalar・入れ子・root・重複label、hidden列、overflow・REALへの移行・再bindを検査する。[MoonBitテスト](../../packages/sqlike/src/full/json_table_wbtest.mbt)で専用経路への到達も確認する。

## JS / AOTの型付きAPI

公開entryは`@mizchi/sqlike/aot/native`と、runtimeを注入する`@mizchi/sqlike/aot/core`。初期実装の`/aot`から、[portableなAOTとの分離](sqlike-build-contract.md)でnative専用entryへ移した。既存JSON ABIを残し、rawの`values_typed` / `execute_typed`を追加した。SELECT handleはStatementを再利用し、named executeは同じProgramの準備済みmetadataと通常のatomic書き込みを使う。

bindはValueのunionをJSで検査してMoonBitのValueへ変換し、Statement.bindを通す。int64外のBigInt、非有限REAL、未対応型・不正なUTF-16を拒否する。BLOBを所有する境界と、成功・bind失敗・評価失敗でのreset / finalizeを検査する。エラー時だけ従来のエラーJSONからmessage / codeを取り出す。

型付きbindの差分で、既存のREAL列へ-0を書いた場合に符号を残す不一致を発見した。REAL affinityで+0へ正規化し、INSERT / UPDATE RETURNING・AFTER trigger・後続のSELECTを本家と照合する。無affinity / BLOB列とCAST・直接bindの-0は維持する。binary wireの符号保存テストは無affinityの列で継続する。

hostは明示prepareの寿命管理、上限付きLRU、restore、同期transaction、rollback後のraw handle破棄と再準備、closeを提供する。通常entryからengine / bridgeが除去されること、選択buildのparser除去・必要機能不足の拒否・生成型、独立npm consumerのNode / Chromium / offline再実行を検査する。型付きbindでも共有586ケースと上流1,000問い合わせを照合する。

binary defined・Wasm向けnative ABI・chunk / streaming結果は残る。新しいnpm entryはまだ公開していない。[ユーザー向けAPI](../native-aot.md)、[hostの回帰](../../tests/sqlike-native-runtime.test.ts)、[raw / catalog / corpusの差分](../../tests/sqlike-aot-typed-experiment.test.ts)。

## 計測

作業直前のJS / Wasm artifactを凍結し、同じNode processで前後を比較する。5千 / 10万行、native期待値、warmup後3サンプル、初期化・prepare・永続化・RPCを除外する。pointは20ms目標・最大1,000反復、JSON展開は1文×3回。現在の公開版との比較ではない。

- [通常式PK検索の前後](../../measurements/point-projection-paired.json)
- [JSON展開集約の前後](../../measurements/json-table-stream-paired.json)
- [ChromiumのAOT境界比較](../../measurements/native-aot-bindings-current.json)
- [エンジン・hostの容量](../../measurements/performance-next-size-current.json)

型付き境界のChromium比較は、全経路をnativeのValue[][]へそろえる。JSON経路には結果のJSON.parse・Cell変換を含み、native結果＋JSON bindとnative結果＋native bindを分ける。host adapter・clock処理を計時しない。bind配列も計時外に作り、両端で値・型を照合する。

<!-- performance-next-results:start -->
Apple M5 / Node 24.22.2。作業直前の凍結artifactと現在の同時比較、中央値。

通常式`n*2`の主キー1行取得。単位はµs / 回。

| 行数 | JS前 | JS後 | Wasm前 | Wasm後 | SQLite prepared |
| --- | ---: | ---: | ---: | ---: | ---: |
| 5,000 | 5,258.48 | 3.23 | 2,898.49 | 2.81 | 0.30 |
| 100,000 | 93,852.29 | 3.86 | 91,777.33 | 1.04 | 0.27 |

JSON展開＋SUM(atom)・COUNT。単位はms / 回。

| 展開行数 | 関数 | JS前→後 | Wasm前→後 | SQLite prepared |
| --- | --- | ---: | ---: | ---: |
| 5,000 | json_each | 17.12→6.28 | 6.28→1.21 | 0.17 |
| 5,000 | json_tree | 15.30→6.48 | 5.22→1.20 | 0.17 |
| 100,000 | json_each | 260.93→91.96 | 134.88→26.73 | 3.66 |
| 100,000 | json_tree | 244.94→91.82 | 128.66→26.38 | 3.43 |

Chromium 158.0.8127.18、3サンプル。既存AOT JSON APIと、prepared native結果・typed bindを比較する。各セルの単位は処理欄に示す。

| 行数 | 処理 | AOT JSON | native結果・JSON bind | native結果・typed bind |
| --- | --- | ---: | ---: | ---: |
| 1,000 | PK取得（µs） | 1.50 | 0.60 | 0.42 |
| 1,000 | 全件取得（ms） | 0.45 | 0.15 | 0.15 |
| 100,000 | PK取得（µs） | 1.54 | 0.62 | 0.42 |
| 100,000 | 全件取得（ms） | 80.30 | 17.15 | 16.70 |

容量はエンジン単体、Oxc minify / Brotli quality 11。単位はB。通常SQLとmanual profileは同一exports。native AOTはtyped API・接続状態copyの追加で11→14 exportsとなり、全3変更を含む前後比較である。

| 構成 | minified前→後 | 増分 | Brotli前→後 | 増分 |
| --- | ---: | ---: | ---: | ---: |
| SQL engine | 716,048→724,928 | +8,880 | 132,713→133,950 | +1,237 |
| native AOT engine | 603,882→617,913 | +14,031 | 113,735→115,989 | +2,254 |
| JSON table profile aot/false | 473,190→474,937 | +1,747 | 89,232→89,213 | -19 |
| JSON table profile aot/true | 498,495→507,568 | +9,073 | 93,589→94,860 | +1,271 |
| JSON table profile defined/false | 441,822→443,569 | +1,747 | 86,324→86,425 | +101 |
| JSON table profile defined/true | 466,857→475,946 | +9,089 | 90,617→91,861 | +1,244 |

notes-selected native AOT: minified **420,857 B**、Brotli **80,401 B**。

npm aot.js: minified **620,232 B**、Brotli **116,827 B**。

npm aot-core.js: minified **2,042 B**、Brotli **916 B**。

notes選択版はエンジン単体、npm行はhostと到達可能なESM chunkの合計で、別の配信条件。hostのみのaot/coreへ既定engineは含めない。通常SQLの増分は主キーprojection・JSON集約・REAL zero修正を含み、native bridgeは通常entryから除去される。圧縮後の差は配置・辞書の影響を含み、機能別の増分を合算しない。

全体回帰はMoonBit **81件×JS / Wasm**、Node **472件**、Chromium **59件**、型検査・本家Litestream復元を通過。586ケース×12経路は各環境3,508一致・4件の双方AOT prepare拒否・4件の対象外DDL、不一致0・oracle drift 0。native AOTのJSON bind / typed bindは各582 trace一致・2件双方prepare拒否・2件対象外DDL、上流1,000問い合わせも一致。全機能監査は466一致・236 atomic拒否で、全SQLite互換は未達。
<!-- performance-next-results:end -->

```sh
just performance-next-check
just native-aot-bench
pnpm exec node --expose-gc --import tsx scripts/bench-generated-columns.ts --before-dir=generated/performance-next-before --output=measurements/point-projection-paired.json
pnpm exec node --expose-gc --import tsx scripts/bench-json-table.ts --before-dir=generated/performance-next-before --output=measurements/json-table-stream-paired.json
pnpm exec tsx scripts/measure-json-table.ts
pnpm exec tsx scripts/measure-performance-next.ts
LITESTREAM_BIN=/path/to/litestream just check
just differential-audit
```
