# json_each / json_tree（未リリース）

JSON配列・objectを行へ展開する`json_each()` / `json_tree()`を、任意機能`jsonTableFunctions`として追加した。動的SQL、JSON AOT、バイナリ事前定義のJS / Wasmで使える。

```sql
SELECT documents.id, item.key, item.value
FROM documents, json_each(documents.doc) AS item
WHERE json_valid(documents.doc)
ORDER BY documents.id, item.rowid;
```

`json_each`は直下の要素、`json_tree`はrootを含む再帰的な要素を返す。scalarは1行、空のarray / objectはeachでは0行・treeではrootの1行。SQL NULL入力は0行となる。先行source・外側の問い合わせを参照でき、INNER / CROSS / LEFT JOIN、複数のJSON tableの連鎖、INSERT SELECT、対応済みUPDATE FROMへ組み合わせられる。

## 機能選択とAOT

```ts
import { defineSqlike, jsonTableFunctions } from '../../src/sqlike-features.ts';
import { buildSqlikeRuntime } from '../../scripts/build-sqlike-runtime.ts';

await buildSqlikeRuntime(
  defineSqlike({ mode: 'defined', features: [jsonTableFunctions] }),
  { outDir: 'generated/json-tables' },
);
```

`catalog`を渡すビルドではschema / queryのIRから自動選択する。JSON展開だけなら`sqlJson`は不要。`json_valid`・`json_array`等を併用する場合は`sqlJson`と該当する関数群も選択する。SQL parserと、使わないscalar JSONの実装をAOT / binary runtimeへ含めないことを検査する。

Sourceの予約名と`$json-table` Callへ関数名・引数・root・ON条件を記録する。AST / binary wireのfield・variantは増やさず、requiredFeatures bit **8192**を使う。機能を外したruntime・旧binary readerは初期化時に拒否する。prepared metadataへ解析したJSON、展開行、bind値を保持しない。

## 出力と対応範囲

| 列 | 値 |
| --- | --- |
| `key` | 配列indexはINTEGER、object labelはTEXT、top-level scalarはNULL |
| `value` | SQLのNULL / INTEGER / REAL / TEXT。array・objectは空白を除いたJSON TEXT |
| `type` | null / true / false / integer / real / text / array / object |
| `atom` | scalarのSQL値。array・objectはNULL |
| `id` / `parent` | JSON内の識別子と親の識別子。eachのparent、treeの開始点のparentはNULL |
| `fullkey` / `path` | 要素へのpathと、その親コンテナへのpath |
| hidden `json` / `root` | 入力をTEXTへ変換した値と開始path。starには含めない |
| hidden `rowid` / `_rowid_` / `oid` | 呼び出しごとに0から始まる行番号 |

重複label、元の数値表記と文字列・キーのエスケープ、64bitを超える数値のREAL化、UTF-8のbyte長を考慮する。`id`は単純な連番ではなく、参照SQLiteのJSONB配置に対応する位置から計算する。array / objectの`value`は、同じSELECT内のJSON constructor・集約へsubtypeを渡す。

現在のroot指定は`$`または1要素のpathに対応する。例えば`$.items`、`$."a.b"`、`$[1]`、`$[#-1]`。欠落pathとSQL NULL rootは0行。開始点のidと子のparentは元のJSON全体の位置を使う。

`id`の計算法はSQLite側で将来変わり得る内部仕様である。[SQLiteの関数説明](https://www.sqlite.org/json1.html#jeach)と[参照実装](https://github.com/sqlite/sqlite/blob/master/src/json.c)を根拠に、現在のNode SQLite / SQLite WASMで差分検証する。長期保存用の安定IDとしての互換性は宣言しない。

## 名前解決と拒否する範囲

JSON tableの引数は先行sourceと相関できる。後続sourceの参照や、UPDATE FROMの更新対象をRHS内部から参照する形は拒否する。同名の通常表・view・CTEで関数が隠された場合も、関数として受理しない。

- JSON5、BLOB / JSONB、`jsonb_each` / `jsonb_tree`は未対応。
- 複数要素のroot、root内のbackslash escape・NULは明示拒否する。例えば`$.a[0]`は初期範囲に含めない。
- JSON tableを直接含むRIGHT / FULL JOIN、schema修飾・引数なしの呼出し、汎用virtual table登録APIは含めない。
- hidden `json` / `root`のWHERE・ON・HAVING条件は拒否する。SQLiteのvirtual table plannerが入力制約として扱う場合を、普通の行filterへ読み替えない。入力は関数引数で指定する。
- JSON table由来の値を、relation境界やmin / max等を経由してJSON constructorへ暗黙に渡す形は拒否する。SQLiteのflattening次第でsubtypeが残るため、現在の実体化経路から推測しない。必要なら`json_array(json(value))`のように、JSONとして読む意図を明示する。通常のTEXT / 数値としての取得は利用できる。
- eponymous JSON tableへの`table_info` / `table_xinfo`は未対応として拒否する。

先行するJSON入力の検査では、修飾した`json_valid(documents.doc)`というAND条件を展開前に評価する。その他のWHERE条件のpushdownやJOINの並べ替えは行わない。別の条件で除外される不正JSONをSQLiteが展開しない場合でも、SQLikeでは拒否することがある。`CASE`等で有効なJSONを引数へ渡す形も使える。

## 実行費用と検証

一般経路はJSON木・JSONBのサイズ情報・展開したenvironmentを、そのSELECTの一時状態として保持する。単一sourceのCOUNT / SUM / TOTAL / AVGには、[展開行・JSONB配置の補助木を作らないvisitor](performance-next.md)を追加した。対応する直接列・literal・COUNT(*)に限定し、WHERE・JOIN・DISTINCT・FILTER・ID / path等は従来経路へ戻す。JSON DOMは残り、汎用iterator・結果streamingは未実装。現在は1入力1 MiB、1 SELECTのJSON table全体で入力16 MiB・解析node 200,000個・path文字列16 MiB、深さ128、展開結果100,000行を上限とする。既存JOIN / SELECTの上限も適用し、一定時間・低メモリの保証とはしない。

[差分テスト](../../tests/sqlike-json-table.test.ts)は6経路の基本・相関・型・ID・subtype・rollbackと、seed固定32種類のJSONを含む。[独立したAOT / binary profile](../../tests/sqlike-json-table-profile.test.ts)、[機能除去](../../tests/sqlike-optional-functions.test.ts)、[wireと資源上限](../../packages/sqlike/src/full/json_table_wbtest.mbt)も検査する。共有corpusへ4ケースを追加した。

容量は[同一exportsの有効・無効比較](../../measurements/json-table-size-current.json)、5千 / 10万行の展開は[計測JSON](../../measurements/json-table-speed-current.json)へ記録する。サイズはエンジン単体、JSはOxc minify / Brotli quality 11。時間はNodeのprepared SQL、JSON解析・展開・SUM(atom)＋COUNT・host境界を含み、prepare・永続化・RPCは含めない。treeの展開行数はrootを含めて数える。

| JSエンジン | 無効・minified | 有効・minified | 増分 | 無効・Brotli | 有効・Brotli | 増分 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| JSON AOT | 474,937 | 507,568 | +32,631 | 89,213 | 94,860 | +5,647 |
| binary defined | 443,569 | 475,946 | +32,377 | 86,425 | 91,861 | +5,436 |

全core関数群を残し、他の選択機能を外したmanual profileの比較。JSON tableだけを使うcatalog profileでは、関数群と他の実装も別途除去できる。機能を外した側にもIRの認識・検査等の共通処理が残り、追加前からの増加が0 Bになることは意味しない。

Apple M5 / Node 24.22.2、3サンプルの中央値。単位はms / 回。

| 展開行数 | 関数 | SQLite prepared | SQLike JS | SQLike Wasm GC |
| --- | --- | ---: | ---: | ---: |
| 5,000 | json_each | 0.18 | 6.40 | 1.25 |
| 5,000 | json_tree | 0.17 | 6.22 | 1.11 |
| 100,000 | json_each | 3.70 | 94.21 | 27.94 |
| 100,000 | json_tree | 3.53 | 90.86 | 27.24 |

この計測は平坦な整数配列で、返却は集約結果の1行。上の集約visitorを使う現在の計測であり、[追加前後の比較](performance-next.md)も別に保存する。10万行の結果をhostへ全転送する費用や、深いobjectの費用を示さない。SQLiteとの差は残る。WHERE / JOINでも必要な列だけを生成する処理、JSON DOMを作らない解析、結果streamingを次の候補とする。割当量・peak memoryと各処理の内訳は未計測。

全体の回帰はMoonBit **81件×JS / Wasm**、Node **472件**、Chromium **59件**、型検査・本家Litestream復元を通過。586ケース×12経路の共有差分は各環境3,508一致・4件の双方AOT prepare拒否・4件の対象外DDL、不一致0、oracle drift 0。全機能監査は466一致・236 atomic拒否で、SQLite全機能互換は未達のまま。

```sh
just json-table-check
just measure-json-table
just json-table-bench
LITESTREAM_BIN=/path/to/litestream just check
just differential-audit
```
