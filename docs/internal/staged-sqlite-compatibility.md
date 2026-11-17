# SQLite互換機能の段階的な導入

更新日: 2026-11-17。0.1.1での追加機能。全SQLite互換の宣言ではない。

小さい基本機能はcoreに加え、大きい機能は必要な利用者だけがビルド時に選ぶ。既存の`defineSqlike({ mode, features })`と`buildSqlikeRuntime()`を使い、SQL文字列・JSON AOT・バイナリ事前定義の3モードで同じ機能境界を保つ。利用例は[機能選択](sqlike-feature-profiles.md)。

リポジトリ内でのビルド例。基本演算だけなら`features: []`で動き、JSON演算子を使う場合だけ`sqlJson`を加える。生成したruntimeは`@mizchi/sqlike/defined/core`へ注入する。

```ts
import { defineSqlike, primaryKeyIndex, sqlJson } from '../../src/sqlike-features.ts';
import { buildSqlikeRuntime } from '../../scripts/build-sqlike-runtime.ts';

await buildSqlikeRuntime(
  defineSqlike({ mode: 'defined', features: [primaryKeyIndex, sqlJson] }),
  { outDir: 'generated/sqlike' },
);
```

## 完了した最初の段階

- [x] `IS DISTINCT FROM` / `IS NOT DISTINCT FROM`を既存の`IS NOT` / `IS`へ正規化。affinity・collation・boolean literalの挙動を共有する。
- [x] `&` / `|` / `~`をcoreへ追加。既存のint64変換を使い、JSの32bitビット演算へ変換しない。NULL伝播と優先順位を検証する。
- [x] `sign()`をcoreへ追加。数値へ変換できないTEXT・BLOB・NULLはNULLを返す。
- [x] JSONの`->` / `->>`を既存の`sqlJson`へ追加。新しいfeature tokenは増やさない。
- [x] JSON演算子を既存のCall IRへ変換し、既存のrequiredFeatures bit 16を記録。AST / wire formatのvariantを増やさない。
- [x] `sqlJson`を省いた生成物にJSON評価器を含めず、未実行CASE・空テーブル・schema式でも必要機能不足を初期化時に拒否する。
- [x] JSON文字列のエスケープ表記を保持。例えば`json('{"a":"\u0062"}')`が勝手に`{"a":"b"}`へ変わらないよう修正。キーの照合はデコードした値を使い、未変更のキー・文字列の出力は元の表記を使う。

`->`はJSONテキストとJSON subtypeを返し、`->>`はSQLの格納クラスの値を返す。欠落とJSON null、負の配列index、フィールド名・path、64bit境界を本家と比較する。未対応のNUL入りpathは明示拒否し、途中で切ったpathで成功しない。

検証は[基本演算](../../tests/sqlike-basic-compat.test.ts)、[JSON演算子](../../tests/sqlike-json-operators.test.ts)、[機能選択](../../tests/sqlike-optional-functions.test.ts)。動的SQL / AOTのJS / Wasm、バイナリcatalogのJS / Wasmを含む。文の途中でJSON pathエラーになった場合のrollbackも確認する。

最初の段階（`ea36a5f`）では18テストと`just p0-check`を通過。MoonBit 53件×JS / Wasm、Node 315件、Chromium E2E 56件、566ケース×8経路の差分監査で失敗0。全機能監査のprobe一致は432→437、候補エラーは270→265、出力不一致は0。現行の追加分は次節に記録する。

```sh
just staged-compat-check
just bundle-size
LITESTREAM_BIN=/path/to/litestream just p0-check
```

## 容量の判定

この表は最初の段階の記録。追加前はcommit `79efe6d`の[固定した計測](../../measurements/staged-compat-before.json)、追加後は`ea36a5f`時点の[次段階の基準](../../measurements/basic-query-before.json)を使う。同じ公開entry・Oxc設定で全JS chunk / Worker / Wasmを合算し、Brotliはファイルごとにquality 11で測る。バイナリschema / statementは別のアプリ資産で、この表には含めない。

<!-- staged-size:start -->
単位はB（byte）。未圧縮はminify後の配信物の合計。

| 構成 | 未圧縮・追加後 | 未圧縮の増分 | Brotli・追加前 | Brotli・追加後 | Brotliの増分 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 通常SQL / JS | 595,159 | +2,738 | 112,001 | 112,554 | +553 |
| 通常SQL / Wasm | 527,794 | +2,520 | 165,216 | 166,065 | +849 |
| 事前定義・全実行機能 / JS | 486,582 | +2,330 | 97,347 | 97,546 | +199 |
| 事前定義・全実行機能 / Wasm | 433,214 | +2,419 | 139,246 | 139,890 | +644 |
| 事前定義・JSON/日時/windowなし / JS | 451,458 | +698 | 90,052 | 90,053 | +1 |
| 事前定義・JSON/日時/windowなし / Wasm | 406,118 | +739 | 129,741 | 130,148 | +407 |
| 事前定義・主キー索引のみ / JS | 435,629 | +702 | 87,153 | 87,274 | +121 |
| 事前定義・主キー索引のみ / Wasm | 392,452 | +499 | 126,010 | 126,195 | +185 |

通常SQLのJS版はBrotli +553 B（約0.49%）、事前定義の全実行機能JS版は+199 B（約0.20%）。JSON・日時・windowなしのJS版は未圧縮+698 B / Brotli +1 B、主キー索引だけのJS版は未圧縮+702 B / Brotli +121 B。軽量な基本演算をcoreへ加え、JSONの追加実装はsqlJsonを選ぶ構成に限定した。sqlite-wasmとTursoのサイズは追加前後で同一。
<!-- staged-size:end -->

圧縮率や内部名の変化により、機能を除外したビルドでも圧縮後のbyte数はわずかに変動する。容量差と生成物の実装有無を両方確認する。サイズが小さいという理由で出力互換やatomic拒否を緩めない。

## 後続のチェックリスト

### 承認された優先順の実装

次の順番で実装した。0.1.1で追加した機能である。

- [x] **1. LIKE ESCAPE / scalar min・max** — 既存Call / Binary IRとint64比較を再利用。NULL・storage class・同値時の返却型・collation・escapeの優先順位を差分検証。LIKEの50,000 byte上限とNULの扱いも合わせる。
- [x] **2. NULLS FIRST / LAST・名前付きSQL parameter** — NULL順序の指定はORDER BY専用の内部Callへ記録し、式を1回評価したkeyを比較する。`:name` / `@name` / `$name`は大文字小文字・接頭辞を区別し、同じ名前を同じParameter位置へ解決する。`?NNN`との混在、Tcl形式も検証。既存SQL APIのbindは位置順配列のままで、named objectの受付はDrizzle事前定義entryが担当する。
- [x] **3. 索引metadata** — `schemaMetadata`で`index_list` / `index_info` / `index_xinfo`を選択。通常・部分・式・対応範囲の自動索引、WITHOUT ROWIDのkey / 補助列を返す。旧Table形式からPKとUNIQUEの宣言順やPK方向を復元できない場合は明示拒否する。
- [x] **4. FROM subquery・集約FILTER** — FROM subqueryをprivate CTEへ変換し、実行器を再利用する。private名は宣言の正規化・rename・再開で安定する。重複列名の自動改名は未対応として拒否。`aggregateFilter`で通常 / DISTINCT / window集約のFILTERを選択でき、除外した行の引数を評価しない。
- [x] **5. JSON集約** — `sqlJson`へ`json_group_array` / `json_group_object`を追加。空集合、順序、重複キー、subtype、DISTINCT、FILTERの組合せを照合。BLOB値・NULLのobject label・JSON集約のwindow利用は明示拒否する。
- [x] **6. Drizzleの事前コンパイル** — [compilerと実行entry](../drizzle-prepared.md)を分割。query builderのSQL・constant / placeholder配置・標準codecをビルド時にデータ化。実行側にORM / parserを含めない。JS / Wasm、Chromiumの最小ビルド・IndexedDB再開、破損・不正bind後の非変更を検証する。

この6項目の追加時点では`just staged-compat-check`の38テストを通過。Drizzleから見つかった、整数へ損失なく変換できるREAL / TEXTのLIMIT・OFFSETも本家に合わせた。JSON数値は既存のSQLite互換formatterを再利用し、負のゼロ・指数・Infinity表記の差を修正した。内部IR用の関数をSQLから直接呼んで受理される問題も、native / 動的JS・Wasm / MoonBit compilerの拒否テストを追加して修正した。

`ae5df09`時点の`just p0-check`はMoonBit 53件×JS / Wasm、Node 335件、Chromium E2E 56件を通過。566ケース×8経路の差分監査は失敗0。全機能監査は449 probe一致・253 atomic拒否・出力不一致0で、未対応・未検証が残るため全機能互換とは判定しない。[現行の検証記録](../../measurements/p0-completion.json)は後続の変更も含む。

大きめの追加は既存の選択APIへ入れる。バイナリの必要機能bitは`schemaMetadata=128`、`aggregateFilter=256`。旧readerや機能を外したruntimeは、未実行の定義も初期化時に拒否する。NULL順序の内部CallはORDER BYの外で受理せず、旧runtimeも未知の関数として拒否する。AST / wireのfieldやvariantは増やしていない。

<!-- priority-size:start -->
基準は`ea36a5f`の[追加前](../../measurements/basic-query-before.json)、追加後は`ae5df09`時点の[次段階の基準](../../measurements/basic-expression-before.json)。単位はB。未圧縮はminify後。

| 構成 | 未圧縮・追加後 | 未圧縮の増分 | Brotli・追加後 | Brotliの増分 |
| --- | ---: | ---: | ---: | ---: |
| 通常SQL / JS | 611,028 | +15,869 | 115,317 | +2,763 |
| 通常SQL / Wasm | 540,657 | +12,863 | 170,326 | +4,261 |
| 事前定義・全実行機能 / JS | 500,049 | +13,467 | 100,426 | +2,880 |
| 事前定義・全実行機能 / Wasm | 444,604 | +11,390 | 143,499 | +3,609 |
| 事前定義・JSON/日時/windowなし / JS | 462,573 | +11,115 | 92,505 | +2,452 |
| 事前定義・JSON/日時/windowなし / Wasm | 415,950 | +9,832 | 133,289 | +3,141 |
| 事前定義・主キー索引のみ / JS | 440,764 | +5,135 | 88,288 | +1,014 |
| 事前定義・主キー索引のみ / Wasm | 396,811 | +4,359 | 127,823 | +1,628 |

主キー索引のみのJS版はBrotli +1,014 B（約1.16%）。通常SQLのJS版は+2,763 B、全実行機能の事前定義JS版は+2,880 B。JSON・日時・windowを外した構成にもschemaMetadata / aggregateFilterは含まれる。これらも不要ならfeaturesから省く。sqlite-wasm / Tursoの容量は同一。

任意のDrizzle prepared adapter単体はminified 4,092 B / Brotli 1,420 B。既定entryへ追加せず、注入するengine / factory・catalog・binding planは別資産。[計測](../../measurements/drizzle-defined-size-current.json)。別々の圧縮値を全アプリの増分として単純加算しない。
<!-- priority-size:end -->

### S02 基本式の追加

- [x] GLOB / NOT GLOBを既存のCall IRへ変換し、glob(pattern,text)と共通評価する。大小文字・範囲・否定class・`]` / `-`・Unicode・NUL・NULL・BLOB変換を本家と比較する。
- [x] char()はコード点からTEXTを構築し、NUL・型変換・範囲外のU+FFFDを保持する。サロゲートは不正UTF-8を別の値へ置換せず、文の変更を公開する前に拒否する。
- [x] 16進・桁区切り数値literalはparserで既存のINTEGER / REALへ変換する。符号付き64bit境界、先頭ゼロ、桁あふれ、separatorの位置、列名の元表記を検証する。CAST / bindの数値変換は従来の十進構文を維持する。
- [x] 単項演算子をCOLLATEより先に結合させる。負の16進最小値は本家と同じく拒否し、COLLATEを内側で括弧に包んだ式との違いも検証する。
- [x] U+FFFE / U+FFFFの保存bytesを変えず、GLOB / LIKE / unicodeがコード点を読む時だけ本家と同じU+FFFDへ写像する。サロゲートとBMP以外の非文字は区別する。
- [x] 関数の1,000引数上限を準備時に検査する。char / concat / scalar minの1,001引数を拒否し、上限ちょうどのcharを本家と比較する。INリストは関数上限の対象にせず、内部用のin()のSQLからの直接呼出しは拒否する。
- [x] 新規9テストを追加し、`just staged-compat-check`は47テスト。動的 / AOTのJS・Wasmに加え、全任意機能を外したSQL / AOT / definedのJS・Wasmで実行し、数値parserが配信されないことも検査する。Chromiumの既存scalar corpusにも8入力を追加する。

GLOBはpatternを一度解析し、直近の`*`の位置だけを保存して反復照合する。再帰・指数的な分岐探索を使わず、patternと入力の文字列長に比例する補助メモリを使う。最大時間はpattern長×入力長に比例し得る。50,000 byte上限は最初のNUL以降も含むpattern全体に適用する。

全回帰はMoonBit 53件×JS / Wasm、Node 344件、Chromium E2E 56件と型チェック・本家Litestream復元を通過。566ケース×8経路の差分監査は失敗0。全機能監査は454 probe一致・248 atomic拒否・出力不一致0で、未対応・未検証を一致へ含めない。

<!-- s02-size:start -->
容量の基準は`ae5df09`の[追加前](../../measurements/basic-expression-before.json)、追加後は`0e5392d`時点の[次段階の基準](../../measurements/catalog-profile-before.json)。公開entry・Oxc設定・集計対象・Brotli quality 11をそろえた。単位はB、未圧縮はminify後。

| 構成 | 未圧縮・追加後 | 未圧縮の増分 | Brotli・追加後 | Brotliの増分 |
| --- | ---: | ---: | ---: | ---: |
| 通常SQL / JS | 616,425 | +5,397 | 116,490 | +1,173 |
| 通常SQL / Wasm | 545,809 | +5,152 | 171,379 | +1,053 |
| 事前定義・全実行機能 / JS | 502,811 | +2,762 | 100,784 | +358 |
| 事前定義・全実行機能 / Wasm | 447,412 | +2,808 | 144,277 | +778 |
| 事前定義・JSON/日時/windowなし / JS | 465,336 | +2,763 | 93,007 | +502 |
| 事前定義・JSON/日時/windowなし / Wasm | 418,589 | +2,639 | 133,980 | +691 |
| 事前定義・主キー索引のみ / JS | 443,526 | +2,762 | 88,872 | +584 |
| 事前定義・主キー索引のみ / Wasm | 399,554 | +2,743 | 128,769 | +946 |

主キー索引のみのJS版はBrotli 86.79 KiB・+584 B（約0.66%）、全実行機能の事前定義JS版は98.42 KiB・+358 B。通常SQLのJS版は+1,173 Bで、literal用parserの追加も含む。GLOB / charを小さいcore機能として採用し、追加のfeature tokenは増やさない。圧縮後の増分は構成ごとの辞書・配置にも依存する。sqlite-wasm / Tursoと、任意Drizzle prepared adapter単体の容量は同一。
<!-- s02-size:end -->

既存の1,000行・AOT workloadの再計測。単位はµs / 操作、7回の中央値。[追加前](https://github.com/mizchi/sqlike/blob/ae5df09/measurements/sqlite-speed-current.json)と[追加後](../../measurements/sqlite-speed-current.json)は同じ入力・計測方法を使う。永続化・RPCを含まない。

| 処理 | JS 前→後 | Wasm 前→後 | SQLite prepared 前→後 |
| --- | ---: | ---: | ---: |
| 主キー検索 | 2.33→2.31 | 1.62→1.71 | 1.41→1.56 |
| SUM＋COUNT | 16.21→17.06 | 10.68→11.17 | 21.52→22.82 |
| 1行UPDATE | 4.45→4.87 | 3.55→3.73 | 1.27→1.38 |

SQLite側も約6〜11%変動しており、絶対時間の増分を機能追加だけの費用とは断定しない。JS / SQLite比ではSUM＋COUNTは約0.75のまま、UPDATEは約3.50→3.53。この固定workloadの観測を、GLOBの全patternや全workloadでの高速性の証明には使わない。行ストアの保持・ピークメモリとIndexedDB保存も[現行の計測](../../measurements/p0-completion.json)へ再採取した。

仕様参照: [SQLiteの数値literal・GLOB](https://www.sqlite.org/lang_expr.html)、[char / glob](https://www.sqlite.org/lang_corefunc.html)、[UTF-8 reader](https://github.com/sqlite/sqlite/blob/master/src/utf.c)。検証入力は[基本式の差分テスト](../../tests/sqlike-basic-expressions.test.ts)に固定する。

### S03a 丸め関数（未リリース）

- [x] `ceil` / `ceiling` / `floor` / `trunc`を追加。INTEGERをREALへ変えず、REAL / decimal TEXTの格納クラス、負のゼロ、int64境界、無限大、NULを含む数値TEXTを本家と照合する。BLOB・非数値TEXTはNULLを返す。
- [x] `mathRounding`を独立したcore関数群としてcatalogから自動収集し、不使用のAOT / definedから実装を除去する。未実行CASE・空tableでも必要な群を除外したcatalogをロード時に拒否する。
- [x] 通常SQL / AOT / binaryのJS・Wasm計6経路でbind型切替を比較し、誤arityは空結果・書込の前に拒否する。

小さい3演算・4関数名の追加であり、数学関数群全体の実装ではない。format / printf、random / randomblob、三角・対数等の残りはS03として維持する。大きな書式処理や乱数源をこのcore群へ含めない。[回帰テスト](../../tests/sqlike-math-rounding.test.ts)、[catalog別の除去検査](../../tests/sqlike-catalog-profile.test.ts)。仕様は[SQLite math functions](https://www.sqlite.org/lang_mathfunc.html)と[ceilingFunc](https://github.com/sqlite/sqlite/blob/master/src/func.c)を参照する。

### 残る導入単位

以下の導入単位は計画。未実装のfeature tokenや空のAPIは公開しない。各段階をさらに小さい変更に分け、差分テストと有効 / 無効ビルドの容量を示してから完了にする。

| 段階 | 機能 | 導入先と条件 |
| --- | --- | --- |
| [x] S02 基本式 | GLOB、char、16進・桁区切り数値literal | 上記の範囲でcore / compilerへ導入。サロゲート値は明示拒否し、数値parserを事前定義runtimeへ含めない |
| [ ] S03 scalar拡張 | format / printf、random / randomblob、残る数学関数 | 書式処理・乱数源・数学関数群を別の任意実装にする。丸め・型・overflow、乱数源の注入と同期時の扱いを固定する |
| [ ] S04 問い合わせの残り | UPDATE FROM、row value、CTE MATERIALIZED指定 | 必要なIRだけcompilerから記録。大きい実行器変更は任意のquery拡張へ分ける。名前解決、複数一致、順序、実体化と非決定関数の評価回数を検証する |
| [ ] S05 集約・windowの残り | 引数内ORDER BY、named WINDOW、EXCLUDE、集約bare column | window拡張は既存windowFunctions内。集約拡張は容量に応じて分離し、既存の小さい集約を維持する。tie・NULL・frame・代表行の規則を本家と比較する |
| [ ] S06 schema | VIRTUAL / STORED生成列、expression DEFAULT、CREATE TABLE AS SELECT、TEMP、ATTACH / DETACH | schema compilerとruntime評価を分離。生成列は保存形式・再開時の再計算・table_xinfo・制約を含めて設計する。複数DB名前空間は独立した拡張にする |
| [ ] S07 trigger・競合 | BEFOREの書込、INSTEAD OF、RAISE(FAIL / ROLLBACK)、INSERT OR FAIL / ROLLBACK | 既存triggersに必要な追加能力を明示する。部分成功・文rollback・transaction rollbackを区別し、host transactionと同期journalの契約も検証する |
| [ ] S08 JSON・日時の残り | JSON集約window・NULL label、json_each/tree、JSON5 / JSONB、timediff・timezone modifier | 通常JSONの小さい追加とtable-valued / JSONB / timezone実装を別に扱う。sqlJsonやdateTimeを選ぶだけで全拡張が入らない構成を目指す |
| [ ] S09 管理・診断の残り | 索引宣言順・方向の保存、その他PRAGMA、ANALYZE、REINDEX、VACUUM、EXPLAIN、integrity_check | 不足するmetadataはversionと移行を含めて追加する。planner・整合性検査・保守処理は別entry。実際に検査・再構築せず成功扱いにする実装はしない |
| [ ] S10 仮想table | SQLite FTS5、RTree、汎用virtual table API | 既存の任意FTS APIとは別のSQL / 保存互換。登録APIと実装を別モジュールにし、未登録は明示拒否する |
| [ ] S11 保存・native接続 | 上限付きpager、WAL writer / recovery、VFS lock、backup、native ABI | SQL evaluatorとは別のインフラ契約・adapter。IndexedDBの行差分は維持し、SQLite page互換・LTX・多接続の耐障害差分を追加する |

## 各段階の受入条件

1. 最初に本家SQLiteとの差分テストを追加して失敗を確認する。値だけでなく型・結果列名・順序・エラー後の状態も比較する。
2. compilerは必要な機能をIR / catalogへ記録する。runtimeはrequiredFeaturesと実際の式の両方を検査し、改ざんや未実行分岐で回避できないようにする。
3. 無効ビルドで必要機能不足を初期化時に拒否し、保存状態・既存接続へ変更を公開しない。有効ビルドはJS / Wasm、動的 / 事前コンパイルで本家と比較する。
4. wireや保存形式を変える場合はversionと移行契約を先に定義し、古いreaderが誤解釈して成功しないことを確認する。
5. parserを持たない`defined`と最小機能構成を維持する。JSのminify後未圧縮 / Brotli、Wasmを含む配信量、代表workloadの時間・メモリを実測する。
6. currentレポートは実際に再計測する。機能追加だけで既存の計測hashを書き換えない。未対応を差分一致の件数へ合算しない。

現行の不足範囲は[状態台帳](status-and-improvement-plan.md)、固定probeの監査は[SQLite機能監査](sqlite-feature-audit.md)、成功出力を優先する方針は[出力互換の契約](sqlite-output-compatibility.md)を参照。
