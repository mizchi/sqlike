# UPDATE FROM（未リリース）

`updateFrom`を任意機能として追加した。別表・集計結果を使う一括更新を、動的SQL、JSON AOT、バイナリ事前定義のJS / Wasmで実行できる。

```sql
UPDATE inventory
SET quantity = inventory.quantity - daily.amount
FROM (SELECT item_id, sum(quantity) AS amount FROM sales GROUP BY item_id) AS daily
WHERE inventory.item_id = daily.item_id
RETURNING item_id, quantity;
```

catalogを渡す`buildSqlikeRuntime()`は必要機能を自動選択する。手動で選ぶ場合は以下の構成を使う。JSON・trigger・外部キー等を使うschemaには、それぞれの機能も必要となる。

```ts
import { defineSqlike, updateFrom } from '../../src/sqlike-features.ts';
import { buildSqlikeRuntime } from '../../scripts/build-sqlike-runtime.ts';

await buildSqlikeRuntime(
  defineSqlike({ mode: 'defined', features: [updateFrom] }),
  { outDir: 'generated/update-from' },
);
```

## 対応範囲と適用規則

- RHSの通常表・view・FROM subquery・集約結果、対応済みJOINとUSING / NATURALを利用できる。RIGHT / FULL等は既存の機能選択に従う。
- 更新対象の`AS` aliasと、別のaliasを使う自己結合に対応する。FROMのない`UPDATE t AS dst …`も同じ任意機能で扱う。
- WHEREとSETは対象表・RHSを参照できる。RHS内部のJOIN ONやFROM subqueryには対象表を公開しない。RETURNINGは更新対象の列を使い、RHS・対象alias・`TABLE.*`は拒否する。
- 一致した全対象行のSET値を、実際の書き込みより前に確定する。自己結合や、AFTER triggerでRHSを書き換える場合も途中の値を後続行へ混入させない。
- trigger、UNIQUE / CHECK / STRICT、FK検査・CASCADE、RETURNINGは通常UPDATEと同じ行書き込み処理を使う。文途中の失敗は対象表とtriggerの副作用を巻き戻す。
- 書き込み時は元の物理キーで対象を探し直す。WITHOUT ROWIDでは元の主キーを使い、先行triggerによる主キー変更・削除・同じキーの再挿入を本家と照合する。
- 同じ列への複数SETは全式を評価して最後の値を採用する。採用されない式のoverflowも握りつぶさない。

[SQLiteの仕様](https://www.sqlite.org/lang_update.html#update_from)では、一つの対象行に複数の元行が一致すると任意の一行を選ぶ。SQLikeは代表行を一意に確定できない入力として、**値が同じでも、最初の書き込み前に文全体を拒否する**。これは対応範囲の制限であり、複数一致の代表値をSQLiteと一致したものとして扱わない。元表のUNIQUEキーで結ぶか、GROUP BY等で一つに集約してから渡す。

## AOTと実行費用

既存Update ASTのpredicateに予約Call `$update-from`とSelectionを記録し、AST / wireのfield・variantは増やさない。requiredFeatures bit **2048**を使う。無効runtimeはIRも検査して初期化時に拒否し、旧binary readerも未知のbitを拒否する。AOT / binaryへSQL parserを追加しない。

prepared planは列位置・affinity・対象layout・元Selection・探索条件を保持する。結合行・SET値・bind・Storeは保持しない。SQL prepared / AOTはmetadataを再利用し、実行ごとに現在の元行とbindで計算する。restore・clone・schema変更後の再準備も検査する。

単一の物理元表について、rowid / INTEGER PRIMARY KEYと対象列の等値条件を確認できれば、元表のrowid順cacheを二分探索する。他の条件も元のWHEREで再評価する。その他はRHSを実体化し、対象行との組み合わせを走査する。対象とRHSの組み合わせの評価は文あたり100万回まで。既存の中間結果10万行等の上限も適用する。

追加保持量は対象行の参照、実体化したRHS、更新待ち行のSET値に比例する。WITHOUT ROWIDは元の主キーも保持する。単純なrowid探索ではRHS全行のenvironment生成を避ける。hash join・一般の二次索引結合・未対応SET式の列位置化は今後の最適化候補。上限内の全入力について、一定時間・低メモリでの実行を保証するものではない。

### 列slotによる評価

単一の物理元表をrowid / INTEGER PRIMARY KEYで一意に探す経路へ、対象・sourceの列とrowidを直接読むdescriptorを追加した。探索key、完全なWHERE、SETの基本式をprepareし、既存の`updateFromLookup`で実行する。CASE等の汎用式が必要になった時点だけ、同じ列layoutからEnvironmentを作る。実列の`rowid`が隠しrowidをshadowする場合も区別する。

一部の一致条件を満たすだけでWHEREを省略せず、SET値は引き続き全対象行について書き込み前に確定する。sourceのsnapshot、trigger / FK、自己結合の可視性を保持し、未対応の結合形は既存経路を使う。Programには列metadataだけを保存し、実行中の行を保持させない。

[slotと汎用経路のJS / Wasm、AOT / binary比較](../../tests/sqlike-update-from-slots.test.ts)では、遅延CASE・NOCASE・BLOB・int64・shadowされたrowidを検査する。改善はEnvironmentの生成費用が中心で、全対象行のSET値保持をなくしたものではない。

元表のIPKを一意に参照して全対象を更新するprepared SQL。単位ms、warmup後の3サンプル中央値。準備・import・検証を除外し、bindは毎回変える。

| 行数 | JS変更前 | JS現在 | Wasm変更前 | Wasm現在 | SQLite prepared |
| --- | ---: | ---: | ---: | ---: | ---: |
| 5,000 | 13.33 | 5.85 | 11.05 | 3.89 | 0.64 |
| 100,000 | 263.96 | 131.12 | 215.84 | 73.65 | 14.73 |

[全サンプル・SQL・SQLite plan・source / artifact hash](../../measurements/update-from-slots-paired.json)。変更前はslot追加直前に凍結した未リリースfull artifact、現在は今回のソース。公開0.1.2との比較でも、同一ソースのoptimizer有効・無効比較でもない。計時するSQLと既存探索は同じで、RHS全走査を再導入した対照ではない。全行SET値の保持量・peakを測った比較ではない。

```sh
just bench-update-from --before-dir=generated/update-from-before-slots --output=measurements/update-from-slots-paired.json
```

## 残る範囲

先頭WITHを持つUPDATE、triggerの本体内で使うUPDATE FROM、UPDATE OR系の追加、行値によるSET代入は未対応。先頭WITHの代わりにFROM内の対応済みSELECTを利用できる場合は、その形で記述する。複数一致、対象aliasの重複、未対応構文を黙って読み替えない。

## 検証と計測

[差分テスト](../../tests/sqlike-update-from.test.ts)、[parserなしのcatalog選択](../../tests/sqlike-update-from-profile.test.ts)、[機能除去](../../tests/sqlike-optional-functions.test.ts)、[prepared metadataと探索](../../packages/sqlike/src/full/update_from_wbtest.mbt)を用意した。共有corpusにも4ケースを追加し、Node / Chromiumの通常SQL・prepared SQL・AOT各JS / Wasmと、JS native結果の実験entryで実行する。

容量は[同一exportsの有効・無効比較](../../measurements/update-from-size-current.json)、5千 / 10万行の一対一IPK結合は[計測JSON](../../measurements/update-from-speed-current.json)へ記録する。時間はNodeのインメモリprepared SQL、全対象を更新、RETURNINGなし。warmup後にbindを変えて3回実行し、初期化・import・prepare・結果検証・永続化・RPCを計時に含めない。

| JSエンジン | 無効・minified | 有効・minified | 増分 | 無効・Brotli | 有効・Brotli | 増分 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| JSON AOT | 474,937 | 486,253 | +11,316 | 89,213 | 91,551 | +2,338 |
| binary defined | 443,569 | 455,029 | +11,460 | 86,425 | 88,619 | +2,194 |

無効版にも必要機能の検査と共通書き込み処理が残る。機能追加後の共通経路を含め、表の数値は通常式PK検索・JSON集約visitor追加後に再計測した。通常のbundlerだけのtree shakingとは別に、MoonBitビルド時に実装を除去する。

| 更新行数 | SQLite prepared | SQLike JS | SQLike Wasm GC |
| --- | ---: | ---: | ---: |
| 5,000 | 0.63 ms | 12.79 ms | 10.19 ms |
| 100,000 | 14.50 ms | 267.12 ms | 207.50 ms |

10万行でも単純IPK結合の経路は実行できるが、SQLiteとの差は残る。一般結合の100万回上限を超える入力を、この結果から実行可能とはしない。列slotでの式評価、SET値の保持量、一般結合の探索構造を次の改善対象とする。

全体の回帰はMoonBit **81件×JS / Wasm**、Node **472件**、Chromium **59件**、型検査・本家Litestream復元を通過。586ケース×12経路の共有差分は各環境3,508一致・4件の双方AOT prepare拒否・4件の対象外DDL、不一致0、oracle drift 0。全機能監査は466一致・236 atomic拒否で、全SQLite互換未達を維持する。

```sh
just update-from-check
just measure-update-from
just update-from-bench
LITESTREAM_BIN=/path/to/litestream just check
just differential-audit
```
