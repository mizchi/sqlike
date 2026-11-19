# 集約内ORDER BY

2026-11-18、未リリース。利用頻度を優先する[段階導入の最初の項目](staged-sqlite-compatibility.md#アプリで使う機能を優先する順序)。

```sql
SELECT group_concat(name, ', ' ORDER BY position, id) FROM items;
SELECT json_group_array(json_object('id', id) ORDER BY created_at DESC, id)
  FILTER (WHERE visible = 1) FROM items;
```

文字列連結、JSON配列・object、COUNT / SUM / TOTAL / AVG / MIN / MAXの対応範囲へ追加する。SQLiteの[集約関数仕様](https://www.sqlite.org/lang_aggfunc.html)に従い、SELECT全体のORDER BYとは別に入力の順序を指定する。

## ビルドと契約

手動プロファイルでは`aggregateOrderBy`を指定する。JSONには`sqlJson`、FILTERには`aggregateFilter`も必要。catalogを渡すAOT / definedビルドでは型付きIRから自動選択する。

```ts
import { defineSqlike, aggregateOrderBy } from '../../src/sqlike-features.ts';
import { buildSqlikeRuntime } from '../../scripts/build-sqlike-runtime.ts';

await buildSqlikeRuntime(
  defineSqlike({ mode: 'defined', features: [aggregateOrderBy] }),
  { outDir: 'generated/ordered' },
);
```

引数内の順序は予約Call IRで記録し、既存のAST / binary wireのvariant・fieldを増やさない。binaryのrequiredFeatures bit **512**を追加した。旧reader、機能を外したruntimeは定義を初期化時に拒否する。宣言bitを信用するだけでなく、実際の式・未実行CASE・空表・viewも検査する。AOT / binaryへSQL parserは追加しない。

FILTERを最初に評価し、残る行のkey・引数をsorterへ入れてから集約する。同値のsort keyは入力順を保つ。DISTINCTは通常、ソート前の最初の値を残す。単一引数と唯一のsort式が同じ場合は、本家のunique sorterと同様に最後の値を残す。NOCASE / RTRIMやINTEGER / REALが混在すると違いが出るため差分テストする。min / maxは本家同様にsort式を名前解決するが、その値を評価せず入力順で集約する。

sorterの追加保持量はグループ内の入力件数に比例する。任意機能を外すとソート・入力保持・専用JSON出力を生成コードから除去する。既存のORDER BYなしの集約は元の経路で処理する。

## 明示拒否する範囲

- scalar関数へのORDER BY、window呼び出しの引数内ORDER BY、`count(* ORDER BY …)`は本家と同様に拒否する。
- 単一引数・単一ソートキーで、USING / NATURALにより統合・抑制された同名列を別の修飾で参照すると、内部の式同一性を現在のenvironmentから復元できない場合がある。誤った値・代表表記を返さず、準備時に`unsupported aggregate ordering of merged join columns`で拒否する。同じ列参照の表記を使う場合や、複数ソートキーでpayloadを保持する場合は差分検証した範囲で受理する。
- 既存のJSON BLOB値・NULL object label・JSONのscalar subquery / min-maxを経由したsubtypeの制限は維持する。ORDER BY / FILTER / DISTINCTで隠しても検査を迂回できない。
- 集約bare column、named WINDOW、EXCLUDE、JSON集約のwindow利用は今回の対象外。

## 検証と容量

[差分テスト](../../tests/sqlike-aggregate-order.test.ts)はSQL / JSON AOT / binaryのJS・Wasmを比較する。collation、NULL配置、複数キー、同値順、DISTINCT、FILTER、行ごとのseparator、JSON subtypeと重複キー、bind再利用、未対応構文の拒否を含む。[catalog選択](../../tests/sqlike-aggregate-order-profile.test.ts)と[機能の個別選択・除去](../../tests/sqlike-optional-functions.test.ts)も検査する。

共有差分corpusへ4ケースを追加し、prepared SQL・通常SQL・AOTのNode / Chromium各JS・Wasmで同じSQLを検証する。JS native結果の実験entryも同じcorpusを実行する。

同じ公開exportsで`features: []`と`features: [aggregateOrderBy]`を比較する計測は[JSON](../../measurements/aggregate-order-size-current.json)に保存する。coreの全関数群を残した手動プロファイルのエンジン単体で、host adapter・catalogは別資産。minified未圧縮とBrotli quality 11を比較する。

| JSエンジン | 無効・minified | 有効・minified | 増分 | 無効・Brotli | 有効・Brotli | 増分 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| JSON AOT | 474,937 | 484,470 | +9,533 | 89,213 | 91,009 | +1,796 |
| binary defined | 443,569 | 452,919 | +9,350 | 86,425 | 88,023 | +1,598 |

表は通常式PK検索・JSON集約visitor追加後の再計測で、両構成とも`rowValues` / `updateFrom` / `generatedColumns` / `jsonTableFunctions`を無効にする。最初の追加時の数値は[行値追加前の記録](../../measurements/aggregate-order-size-before-row-values.json)へ保持した。圧縮後の増分は配置・辞書の影響で変わる。

無効ビルドには失敗通知・IR検査だけを残し、sorter本体を含めない。多数の異なる値があるDISTINCTの重複判定は既存集約と同じ線形探索であり、キーの索引化は今後の最適化候補。metadataのprepare時再利用とともに、別の性能課題として計測する。

```sh
just staged-compat-check
just measure-aggregate-order
LITESTREAM_BIN=/path/to/litestream just check
just differential-audit
```
