# VIRTUAL生成列（未リリース）

`generatedColumns`を任意機能として追加した。固定DDLとprepared statementから、動的SQL・JSON AOT・バイナリ定義のJS / Wasmで生成列を利用できる。

```sql
CREATE TABLE lines(
  id INTEGER PRIMARY KEY,
  quantity INTEGER NOT NULL,
  price_cents INTEGER NOT NULL,
  total_cents INTEGER GENERATED ALWAYS AS(quantity * price_cents) VIRTUAL
);
INSERT INTO lines VALUES(1, 3, 120) RETURNING id, total_cents;
```

`AS (expression)`だけの省略形もVIRTUALとして扱う。INSERTの列指定を省いた場合は通常列だけを渡す。生成列へのINSERT / UPDATE / UPSERT代入は、空集合になる文も準備時に拒否する。

## 選択と契約

```ts
import { defineSqlike, generatedColumns } from '../../src/sqlike-features.ts';
import { buildSqlikeRuntime } from '../../scripts/build-sqlike-runtime.ts';

await buildSqlikeRuntime(
  defineSqlike({ mode: 'defined', features: [generatedColumns] }),
  { outDir: 'generated/virtual-columns' },
);
```

catalogを渡すビルドはschema内の生成式から必要機能を自動選択する。JSON由来の列なら`sqlJson`と、その式で使うJSON関数群も収集する。SQL parserはAOT / binary runtimeへ追加しない。機能なしのビルドは初期化時に拒否し、依存解決・計算・cacheの実装を除去する。

既存ColumnDefのdefault式へ予約Call `$generated-virtual`を記録し、requiredFeatures bit **4096**を使う。既存AST / binary wireのfield・variantは増やさない。これはDEFAULT値ではなく、生成式を示す内部表現。旧readerは未知の機能bit・式を拒否する。

対応する式は、通常列・生成列・literalと、対応済みの決定的なscalar演算。生成列を通常列の間に配置でき、前方参照を含む依存を並べ替えて計算する。循環、直接ROWID参照、生成列のPRIMARY KEY、DEFAULT、parameter、subquery、集約・window、状態参照や非決定的な関数は定義時に拒否する。依存の深さは64まで。

列自身の宣言でaffinityとcollationを決める。NOT NULL / CHECK / UNIQUE、通常・部分索引、RETURNING、UPSERT、対応済みtrigger / FK、WITHOUT ROWID、UPDATE FROMとの組み合わせを差分テストする。`table_info`は生成列を除外し、`table_xinfo`は元の列番号と`hidden=2`を返す。構文・制約の参照は[SQLite生成列](https://www.sqlite.org/gencol.html)。

## 状態と永続化

生成値はメモリ上の派生cacheに保持する。変更・import・再開時に、通常列と依存順から再構築する。prepared metadataは列番号、affinity、式の実行計画、NULL値のlayoutだけを保持し、行・bind・Storeは保持しない。copy / rollbackは不変のplanを共有し、schema変更では無効化する。

- JSON・binary snapshotでは、生成列のslotをNULL placeholderとして保存する。生成したTEXT / BLOB等のpayloadを保存しない。
- 列差分は通常列だけを記録する。再適用では生成値を再計算し、生成列を指定するpatchは拒否する。
- SQLiteファイルの表recordからVIRTUAL列を除く。生成列を使うindexは評価値を記録する。通常表・WITHOUT ROWIDのJS / Wasm書き出し、native SQLiteの`integrity_check`、物理import、LTX差分を検証する。
- Session互換changesetは生成列のある表を拒否する。captureのcallback実行前に通知し、SQL同期またはSQLite画像 / LTXを利用する。SQLikeのbinary snapshot / journalとSession changesetは別の形式。

現段階では必要な生成列だけを遅延評価しない。保持量は行数×生成列数に応じて増える。繰り返すSELECT・索引検索で計算を再利用する代わりに、書き込み・再開時の計算とメモリを使う。低メモリ構成、依存に変更があった列だけの再計算、不要な生成値の破棄は今後の改善対象。

## 明示拒否する残り

- STORED生成列、生成列が関わるALTER ADD / RENAME / DROP。ALTER ADDは生成列が関わる表を拒否する。RENAMEとDROP COLUMNは、生成列を持つ表が一つでもある状態では一括拒否する。
- REAL affinityの生成列。参照Node SQLite 3.53.4で、`v REAL AS(a)`の整数相当値が、通常projectionではREAL、sorterを通る問い合わせではINTEGERとして返るケースを確認した。誤った返却型で成功させず、定義時に拒否する。NUMERIC / INTEGER宣言と明示CAST等で記述できる場合は、その範囲で利用する。
- 日時関数を含む生成式。固定literalだけの決定的な形も今回は含めない。
- 汎用UDF、全てのSQLite scalar関数、生成列だけの表、行値を生成する式。対応外の関数や型を推測しない。
- `INSERT INTO dest SELECT * FROM src`の生成列転送に関するSQLite固有の最適化。通常列を明示したINSERT SELECTを使う。

## 検証と再計測

[6経路の差分](../../tests/sqlike-generated-columns.test.ts)、[catalogの自動選択と再開](../../tests/sqlike-generated-profile.test.ts)、[SQLite / LTX](../../tests/sqlike-generated-storage.test.ts)、[保存内容・patch検査](../../packages/sqlike/src/full/generated_columns_wbtest.mbt)、[個別選択と実装除去](../../tests/sqlike-optional-functions.test.ts)を用意した。共有corpusへ4ケースを追加し、Node / Chromiumの通常SQL・prepared SQL・AOT各JS / Wasmと、JS native結果の実験entryでも比較する。

容量は[同一exportsの機能あり / なし](../../measurements/generated-columns-size-current.json)、速度は[5千 / 10万行の記録](../../measurements/generated-columns-speed-current.json)へ保存する。エンジン単体のサイズで、host・catalogは含まない。速度はNodeのインメモリprepared SQLで、通常式`n*2`と派生cache済みのVIRTUAL列を比較する。初期化・import・prepare・永続化・RPCを計時に含めず、メモリ使用量の実測として扱わない。

| JSエンジン | 無効・minified | 有効・minified | 増分 | 無効・Brotli | 有効・Brotli | 増分 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| JSON AOT | 474,937 | 482,908 | +7,971 | 89,213 | 90,820 | +1,607 |
| binary defined | 443,569 | 451,425 | +7,856 | 86,425 | 87,752 | +1,327 |

10万行の中央値。単位はµs / 回。

| 問い合わせ | SQLite・生成列 | JS・通常式 | JS・生成列 | Wasm・通常式 | Wasm・生成列 |
| --- | ---: | ---: | ---: | ---: | ---: |
| PKの1行取得 | 0.30 | 3.44 | 3.51 | 1.09 | 0.93 |
| SUM + COUNT | 1,701.00 | 68,024.79 | 1,730.47 | 53,644.71 | 820.52 |
| 同じ値への1行UPDATE | 0.25 | 4.11 | 4.83 | 1.23 | 1.46 |

通常式のpoint取得には、後続の[主キー候補限定](performance-next.md)を適用した。現在の表はその改善後の再計測で、追加前後の比較は別に保存する。通常式の集約は引き続き一般評価へ戻るため、生成列との差はcacheだけでなく、集約fast pathへの到達差を含む。SQLiteに対する一般的な高速性や、値が変わる大量更新の費用を示す表ではない。

全体の回帰はMoonBit **81件×JS / Wasm**、Node **472件**、Chromium **59件**、型検査・本家Litestream復元を通過。586ケース×12経路の共有差分は各環境3,508一致・4件の双方AOT prepare拒否・4件の対象外DDL、不一致0、oracle drift 0。全機能監査は466一致・236 atomic拒否で、SQLite全機能互換は未達のまま。

```sh
just generated-columns-check
just measure-generated-columns
just generated-columns-bench
LITESTREAM_BIN=/path/to/litestream just check
just differential-audit
```
