# 行値比較とカーソルページング

2026-11-18、未リリース。`rowValues`で選ぶ、SQLite行値機能の部分集合。[段階導入の優先順](staged-sqlite-compatibility.md#アプリで使う機能を優先する順序)では集約内ORDER BYに続く項目。

```sql
CREATE TABLE items(id INTEGER PRIMARY KEY, tenant TEXT, created_at TEXT);
CREATE INDEX feed ON items(tenant, created_at, id);

SELECT id FROM items
WHERE tenant = ?1 AND (created_at, id) > (?2, ?3)
ORDER BY created_at, id LIMIT 20;
```

## 対応する範囲

- 列・literal・bind・対応するscalar式から作る2〜1,000要素の行値。`= / == / != / <> / < / <= / > / >= / IS / IS NOT`とDISTINCT FROMの別表記。
- 行値のBETWEEN / NOT BETWEEN、単純CASEのbase / WHEN、IN / NOT INのSELECT・行値リスト・空リスト。
- NULLの三値論理、int64 / REAL / TEXT / BLOB、各要素のaffinity、BINARY / NOCASE / RTRIM、明示COLLATE、統合JOIN列の対応範囲。
- 動的SQL・JSON AOT・binary定義のJS / Wasm。WHERE、CHECK、RETURNING内の比較結果や、通常の式の一部として使える。

[SQLiteの行値仕様](https://www.sqlite.org/rowvalue.html)を参照し、値だけでなく格納クラス・NULL・エラー後の状態を本家と差分検証する。新しい格納クラスは追加せず、各要素は既存の`Value`を使う。

比較は左から進み、大小や不一致が確定したら後続の式を評価しない。等値比較はNULLの後も確定した不一致を探す。たとえば`(1,NULL,3)=(1,NULL,4)`は0、`(1,NULL,3)=(1,NULL,3)`はNULLになる。行値のISはTRUE / FALSEを通常の0 / 1として比較し、scalar ISのboolean特例を適用しない。

BETWEENとCASEのbaseは全要素を一度評価して保持する。INの左側と右側も参照実装の評価順に合わせてmaterializeするが、空のINリストは左側の値を実行せず0を返す。行値リストINの共通affinity / collationは、参照ビルドであるSQLite 3.53.4 / WASM 3.54.1の最終行のmetadataに合わせる。双方の値へ比較用affinityを適用するため、単純な等値比較のOR展開では代用しない。

## ビルド境界

```ts
import { defineSqlike, rowValues } from '../../src/sqlike-features.ts';
import { buildSqlikeRuntime } from '../../scripts/build-sqlike-runtime.ts';

await buildSqlikeRuntime(
  defineSqlike({ mode: 'defined', features: [rowValues] }),
  { outDir: 'generated/rows' },
);
```

catalogを渡すAOT / definedでは、型付きIRから自動で選ぶ。不要なビルドから比較・IN・metadata処理・索引補助を除去し、AOTへSQL parserを含めない。

予約Call`$row`へ要素を記録し、AST / binaryのvariantやfieldは追加しない。requiredFeatures bit **1024**を追加した。機能を外したruntime・旧binary readerは初期化前に拒否する。実際のIRも検査するため、未実行CASE・空表・CHECKの利用を宣言bitだけで隠せない。単独の行値を結果セルやscalar関数の引数として返すことは拒否する。

実行中の値cacheは比較・CASE等のローカル状態であり、Program / Statementへ行・bind・Storeを保持しない。AOT UPDATEの列位置用planは、行値比較をscalarのBoundCompareへ誤変換せず、行値の評価器を使う。

## 索引と費用

列とliteral / bindから作る条件では、二次索引の候補を絞る。対応するORDER BYと索引があり、行値に対応する索引列の方向がそろっていれば、複合キー全体を二分探索する。tenant等の等値prefixにも対応する。混在するASC / DESCや対応外の式は、先頭列の包括的な範囲か走査へ戻す。

候補絞り込み後も行値全体の条件を評価する。先頭列だけの索引で後続列を検査し忘れたり、NULLを通常の全順序として受理したりしない。NULL、境界の厳密さ、逆方向、両側の範囲とtenant prefixは[索引回帰](../../packages/sqlike/src/full/row_values_wbtest.mbt)で検査する。

`rowMetadata` optimizerは、単一の実表を読むSELECTと対応する列slot評価で、行値式のaffinity / collationをprepare時に再利用する。値・bind・Storeは保持せず、各行で現在値を読む。nested SELECTへは引き継がない。CTE・一般JOIN等は既存の経路を使う。

`inListLookup` optimizerは16要素以上のliteral / bind右辺を持つscalar / 行値INを実行ごとに索引化する。右辺は最初の評価時に一度だけ作り、prepared planには保存しない。空表・未実行CASEでは構築せず、再実行・restore後には現在のbindを使う。scalarの整数と厳密に整数と等しいREALはint64 hash、その他と非NULL行値はcollationを反映したキーを使う。行値のNULLを含む候補は、確定した不一致とUNKNOWNを区別して比較する。

`aggregateScan`と併用した場合、WHEREが単一のscalar / 行値INで、左辺が実表の列だけなら、COUNT / SUM / AVG / TOTALの走査で列slotを直接読む。GROUP BY・HAVING・一般の式・JOIN等は既存経路へ戻す。既存のrowid順cacheと同じ比較・NULL判定を使い、全入力のEnvironment生成とgroup保持を省く。scalar / 行値の双方を最適化の有効・無効、AOT / binary、JS / Wasmで比較する。

参照対象はSQLite **3.53.4 / WASM 3.54.1**。scalarの式リストINではREAL列の比較affinityをNUMERICへ置き換えるが、この版の行値リストとIN SELECTでは片側だけのREAL affinityを維持する。`CAST(9007199254740993 AS REAL) IN (9007199254740993)`は0、同じ値の行値IN / IN SELECTは1になる。整数を無条件にdoubleへ変換する共通化はしない。[expr.c](https://raw.githubusercontent.com/sqlite/sqlite/version-3.53.4/src/expr.c)と差分テストで確認した。

compound由来の列は各armのaffinityと値の可能な格納クラスから比較用metadataを決める。scalar subqueryは右端armのaffinityを使い、sourceのcollationは外側へ伝播しない。derived REAL列の読取時にはINTEGERセルをREALに変換する。直接のcompound結果は元の格納クラスを保つ。[select.c](https://raw.githubusercontent.com/sqlite/sqlite/version-3.53.4/src/select.c)の参照版と144通りの型の組合せを6経路で照合した。

非相関IN SELECTの実行単位cache、DMLのliteral / bind IN、JOIN・view・CTEを含む一般sourceのIN索引と保持予算を追加した。[範囲・再実行・予算・計測](in-select-performance.md)を参照。相関RHS・複雑なSELECT・書込中のIN SELECTは従来経路を使う。cache上限は保持を許可するpayloadの概算であり、RHSの実体化や全DBを含めたheap上限ではない。行値等値から専用PK hash索引への直接accessとNULL候補の残余走査は改善候補として残る。

## 明示拒否する残り

- 行値を返すScalarSelectとの比較、行値の各要素に含むsubquery。SELECT右辺を使うINは上の対応範囲で利用できる。
- `(a,b)=(SELECT …)`形式を含む、UPDATE SETの複数列代入。
- IN右辺のトップレベルcompound SELECT、USING / NATURALを使うSELECT、starと他の式を混在させるprojection。復元できないmetadataを推測しない。
- 行値全体へのCOLLATE、入れ子の行値、幅の違う比較・IN、scalar位置への行値。これらは本家が拒否する構文も含む。

## 検証と再計測

[差分テスト](../../tests/sqlike-row-values.test.ts)と[catalog選択](../../tests/sqlike-row-values-profile.test.ts)、[機能の個別選択・除去](../../tests/sqlike-optional-functions.test.ts)を使う。bindを再利用したページング、更新・削除後の索引、整数overflow後の文全体rollback、TRUE / FALSEという列名、INの共通metadataまで比較する。共有corpusには4ケースを追加し、Node / Chromiumの通常SQL・prepared SQL・AOT各JS / Wasmで照合する。

サイズは[有効・無効の同一exports比較](../../measurements/row-values-size-current.json)、5,000 / 100,000行のページングは[計測JSON](../../measurements/row-values-cursor-current.json)へ保存する。時間の比較対象はNodeのprepared SQLで、同じtenant・日時が続くデータの末尾付近から20行を取る。基準は複合キー全体の探索を追加する前の未リリース途中ビルドであり、過去の公開版との比較ではない。3サンプル・各20ms目標、最大1,000反復とし、初期化・索引構築・warmupは計時しない。

同じmanual profileで、他の選択機能を外したエンジン単体のJS容量。単位はB、Brotli quality 11。

| 構成 | 無効・minified | 有効・minified | 増分 | 無効・Brotli | 有効・Brotli | 増分 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| JSON AOT | 474,937 | 489,809 | +14,872 | 89,213 | 91,936 | +2,723 |
| binary defined | 443,569 | 458,452 | +14,883 | 86,425 | 89,053 | +2,628 |

機能を外した構成にも、旧readerとの安全な境界を保つIR認識・検査は残る。[行値追加前の同条件](../../measurements/aggregate-order-size-before-row-values.json)に対し、無効のAOT / binaryはminifiedで各+6,967 / +7,043 B、Brotliで各+721 / +959 B。UPDATE FROM・VIRTUAL生成列・JSON table関数・通常式PK検索等の共通処理も含む。実装の除去と完全な0 B増加は同じ意味ではない。

通常の整数列`seq`を比較末尾に置くページング。単位はµs / 20行取得、中央値。JS / Wasmは既存JSON ABIを通り、SQLiteはNodeの配列結果を使う。永続化・RPCは含まない。

| 行数 | JS・先頭列のみ | JS・複合探索 | Wasm・先頭列のみ | Wasm・複合探索 | SQLite prepared |
| --- | ---: | ---: | ---: | ---: | ---: |
| 5,000 | 12,481.02 | 114.02 | 10,521.50 | 57.17 | 2.21 |
| 100,000 | 245,817.46 | 127.00 | 212,693.42 | 61.10 | 2.23 |

`INTEGER PRIMARY KEY`の`id`を比較末尾に置く版も別に計測した。100,000行でJSは248,731.50→118.13 µs、Wasmは214,364.92→57.37 µs。参照SQLiteは2,780.59 µsだが、EXPLAINは`tenant=? AND created>?`までしか使っておらず、通常列版の`(created,seq)>(?,?)`とは異なる。このプラン差を一般的なSQLiteに対する高速性として扱わない。両方のSQL・プラン・全サンプルをJSONに残す。

上の表は複合索引探索を導入した時点のsnapshot。metadata再利用とIN索引化の[同条件の速度・配信量](in-list-performance.md)を別に記録した。生データは[metadataのpaired計測](../../measurements/row-metadata-paired.json)と[scalar / 行値INのpaired計測](../../measurements/in-list-paired.json)。既存JSON ABIとEnvironment生成の費用が残り、通常列版ではSQLiteとの性能差がある。

索引導入時点の回帰はMoonBit 81件×JS / Wasm、Node 472件、Chromium 59件、型検査・本家Litestream復元を通過。586ケース×12経路の差分は各環境3,508一致・4件AOT prepare拒否・4件対象外DDL、不一致0、Node SQLiteとSQLite WASMのoracle drift 0。全機能監査は466一致・236 atomic拒否となり、全SQLite互換未達を維持する。

```sh
just row-values-check
just measure-row-values
just row-values-bench
just bench-row-metadata
just bench-in-list
# 凍結した先頭列だけの候補絞り込み版がある場合
just row-values-bench --before-dir=generated/row-values-before-seek
LITESTREAM_BIN=/path/to/litestream just check
just differential-audit
```
