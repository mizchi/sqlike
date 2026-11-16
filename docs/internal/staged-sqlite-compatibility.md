# SQLite互換機能の段階的な導入

更新日: 2026-11-16。0.1.0以後の未リリース変更。全SQLite互換の宣言ではない。

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

`just staged-compat-check`の18テストと`just p0-check`を通過。MoonBit 53件×JS / Wasm、Node 315件、Chromium E2E 56件、566ケース×8経路の差分監査で失敗0。全機能監査のprobe一致は432→437、候補エラーは270→265、出力不一致は0。全機能互換の判定は未達のまま維持する。

```sh
just staged-compat-check
just bundle-size
LITESTREAM_BIN=/path/to/litestream just p0-check
```

## 容量の判定

追加前はcommit `79efe6d`の[固定した計測](../../measurements/staged-compat-before.json)、追加後は[現行の計測](../../measurements/bundle-size-current.json)を使う。同じ公開entry・Oxc設定で全JS chunk / Worker / Wasmを合算し、Brotliはファイルごとにquality 11で測る。バイナリschema / statementは従来どおり別のアプリ資産で、この表には含めない。

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

以下の導入単位は計画。未実装のfeature tokenや空のAPIは公開しない。各段階をさらに小さい変更に分け、差分テストと有効 / 無効ビルドの容量を示してから完了にする。

| 段階 | 機能 | 導入先と条件 |
| --- | --- | --- |
| [ ] S02 基本式 | GLOB、LIKE ESCAPE、複数引数min/max、char、名前付きbind、16進・桁区切り数値literal | parserのみの機能はビルド時compiler側に置く。評価器の増分を測り、小さければcoreへ加える。pattern照合のNULL・Unicode・NUL、bind番号と名前の割当を差分検証する |
| [ ] S03 scalar拡張 | format / printf、random / randomblob、数学関数 | 書式処理・乱数源・数学関数群を別の任意実装にする。丸め・型・overflow、乱数源の注入と同期時の扱いを固定する |
| [ ] S04 問い合わせ | FROM subquery、UPDATE FROM、row value、NULLS FIRST / LAST、CTE MATERIALIZED指定 | 必要なIRだけcompilerから記録。大きい実行器変更は任意のquery拡張へ分ける。名前解決、複数一致、順序、実体化と非決定関数の評価回数を検証する |
| [ ] S05 集約・window | aggregate FILTER / 引数内ORDER BY、named WINDOW、EXCLUDE、集約bare column | window拡張は既存windowFunctions内。集約拡張は容量に応じて分離し、既存の小さい集約を維持する。tie・NULL・frame・代表行の規則を本家と比較する |
| [ ] S06 schema | VIRTUAL / STORED生成列、expression DEFAULT、CREATE TABLE AS SELECT、TEMP、ATTACH / DETACH | schema compilerとruntime評価を分離。生成列は保存形式・再開時の再計算・table_xinfo・制約を含めて設計する。複数DB名前空間は独立した拡張にする |
| [ ] S07 trigger・競合 | BEFOREの書込、INSTEAD OF、RAISE(FAIL / ROLLBACK)、INSERT OR FAIL / ROLLBACK | 既存triggersに必要な追加能力を明示する。部分成功・文rollback・transaction rollbackを区別し、host transactionと同期journalの契約も検証する |
| [ ] S08 JSON・日時 | json_group_array/object、json_each/tree、JSON5 / JSONB、timediff・timezone modifier | 通常JSONの小さい追加とtable-valued / JSONB / timezone実装を別に扱う。sqlJsonやdateTimeを選ぶだけで全拡張が入らない構成を目指す |
| [ ] S09 管理・診断 | index_info等PRAGMA、ANALYZE、REINDEX、VACUUM、EXPLAIN、integrity_check | 小さいmetadata照会は測定後coreへ。planner・整合性検査・保守処理は別entry。実際に検査・再構築せず成功扱いにする実装はしない |
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
