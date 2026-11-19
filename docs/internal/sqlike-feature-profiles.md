# 機能を選択するランタイム

現行の再計測は[P0結果](p0-results.md)を参照。以下は以前の実装・計測の記録である。

現在の対応・監査件数と今後の改善は[対応範囲と改善台帳](status-and-improvement-plan.md)を参照。末尾の検証件数・計測JSONは各機能を追加した時点の記録である。

RIGHT/FULL JOIN、STRICT、主キー専用索引、trigger、FK付きbinary同期を追加した。既存の全機能エントリは維持し、必要な実装だけを含める場合は**ビルド時にプロファイルを固定**する。

JSON・日時・windowも選択可能。`features: []`では3機能を含めず、利用する場合に`sqlJson`・`dateTime`・`windowFunctions`を明示する。SQL文字列を解析する`sql`、従来のJSON定義を読む`aot`、バイナリ定義だけを読む`defined`の各モードで選択できる。既存の全機能entryを直接importする経路は従来どおり。

0.1.1で、[catalogからの自動選択](../catalog-build.md)を追加した。`buildSqlikeRuntime(profile, {catalog: source, outDir})`で、必須の既存featureに加え、coreの関数群と文の種類も絞る。`catalog`なしの手動プロファイルは、このページの選択単位を維持する。

```ts
// ビルド用コード（Node 24+）
import {
  defineSqlike, primaryKeyIndex, strictTables, rightFullJoin,
  triggers, foreignKeys,
} from './src/sqlike-features.ts';
import { buildSqlikeRuntime } from './scripts/build-sqlike-runtime.ts';

const profile = defineSqlike({
  mode: 'aot',
  features: [primaryKeyIndex, strictTables, rightFullJoin, triggers, foreignKeys],
});
await buildSqlikeRuntime(profile, {outDir: 'generated/sqlike'});
```

```ts
// ブラウザ用コード。全機能版へのデフォルトimportはない。
import * as runtime from './generated/sqlike/runtime.js';
import {openCompiled} from './src/sqlike-runtime.ts';
import {artifact} from './examples/notes/program.generated.ts';
const db = openCompiled(runtime, artifact);
// db.execute('query-name', bindings)
```

JSONの設定ファイルでも生成できる。

```sh
just sqlike-runtime examples/profiles/notes-aot.json generated/notes
just sqlike-runtime examples/profiles/sync-sql.json generated/sync
just feature-profiles
```

生成するJSは既定でOxc minifyを適用する。公開API・property名・purity annotationを維持し、`profile.json`へ`minify: "oxc"`を記録する。調査時はTypeScript APIの`{minify: false}`で非圧縮出力を選べる。生成先には`runtime.js`、`runtime.wasm`、`runtime.d.ts`、`profile.json`、ESM用`package.json`を置く。Wasm GCは`WebAssembly.instantiate(bytes, {}, {builtins:['js-string'], importedStringConstants:'_'})`のexportsを同じAPIへ注入する。画像/LTXの`Bytes` ABIはJSとWasmで異なるため、WasmのJSホストからは`*_base64` exportsで受け渡す。`runtime.d.ts`は生成JSモジュールの宣言を提供する。

## 選択単位

| トークン | 有効になる実装 |
| --- | --- |
| `rightFullJoin` | RIGHT/FULL OUTER JOIN、USING/NATURAL。LEFT/INNER/CROSSのON結合はcoreに残る |
| `strictTables` | STRICTの型制約・ANYの型保存・暗黙のPK NOT NULL |
| `primaryKeyIndex` | rowid/IPK、text・blob・複合PKの等値検索とPK一意制約用のhash索引 |
| `triggers` | 既存のAFTER行trigger、BEFOREの検証SELECT、OLD/NEW/WHEN/UPDATE OF/RAISE |
| `foreignKeys` | 外部キー検査、cascade・参照動作・遅延制約 |
| `sqlJson` | `json()` / `json_*()`によるSQLのJSON解析・構築・編集。0.1.1では`->` / `->>`、`json_group_array` / `json_group_object`も含む。bind / 結果のJSON ABIはcoreに残る |
| `schemaMetadata` | 0.1.1から。`PRAGMA index_list` / `index_info` / `index_xinfo`。通常・部分・式・対応範囲の自動索引とWITHOUT ROWIDのmetadata |
| `aggregateFilter` | 0.1.1から。通常 / DISTINCT / window集約の`FILTER(WHERE …)`。JSON集約と併用するときは`sqlJson`も選ぶ |
| `aggregateOrderBy` | 未リリース。通常 / DISTINCT / JSON集約の引数内ORDER BY。FILTERは`aggregateFilter`、JSONは`sqlJson`も必要。catalogから自動収集し、無効ビルドではsorterを除去する。[制限・容量](aggregate-order-by.md) |
| `rowValues` | 未リリース。列・bind等から作る行値の比較・BETWEEN・CASE・複合INと、適合する二次索引の候補絞り込み。catalogから自動収集する。[対応範囲・制限・容量](row-values.md) |
| `updateFrom` | 未リリース。別表・集約結果・自己結合によるUPDATE、対象alias、RETURNING。全SET値を確定してから適用し、複数元行の一致は書き込み前に拒否する。[対応範囲・容量](update-from.md) |
| `generatedColumns` | 未リリース。VIRTUAL生成列、依存解決、制約・索引・再開時の再計算。生成値は永続化しない派生cache。STORED / REAL affinity / ALTER / Session同期は未対応。[範囲・容量・費用](generated-columns.md) |
| `jsonTableFunctions` | 未リリース。json_each / json_tree、相関INNER / CROSS / LEFT JOIN、型・path・ID。通常のSQL JSONとは別に選択し、JSON木・展開器を除去できる。[範囲・容量・費用](json-table-functions.md) |
| `dateTime` | `date` / `time` / `datetime` / `strftime` / `unixepoch` / `julianday`とCURRENT_DATE / TIME / TIMESTAMP |
| `windowFunctions` | ROW_NUMBER、順位・参照・集約windowとframe評価。通常の集約はcoreに残る |
| `binarySync` | SQLモードのSQLite Session互換changeset捕捉。受信側の抑制APIは別entry |
| `sqlitePages` | AOTのSQLite画像書出し、SQLモードのSQLite画像読込 |
| `ltx` | AOTのLTX生成・適用。`sqlitePages`も指定する |

`catalog`を渡すAOT / definedビルドでは、[自動選択](../catalog-build.md)でJSON内部の7関数群・subtype再解析・JOIN・通常/再帰CTE・複合SELECTも絞る。以下はcatalogを省いた手動プロファイルの説明である。

`features: []`が選択機能なし。CRUD、LEFT/INNER/CROSS JOIN、二次索引、通常の集約、CTE、CAST / affinity用の数値変換などはcoreに残る。`allSqlikeFeatures`は公開トークンの一覧であり、モード固有の`binarySync`/`ltx`はモードに合わせて選ぶ。`defined`はSQLite exporterを別entryとして扱い、`sqlitePages` / `ltx` / `binarySync`を受け付けない。

日時やJSONをアプリで生成してTEXT / INTEGERへbindするだけなら、対応するSQL関数の実装は不要。DDLの`DEFAULT CURRENT_TIMESTAMP`、CHECK、view、trigger等で使用している場合は必要になる。未実行のCASE分岐や空テーブルでも、外した機能を使う定義は初期化時に拒否する。バイナリ定義ではビルド時に記録したrequiredFeaturesと実際のIRを照合する。旧ビルドにあった`json()`単体のbit未記録も修正したため、該当する古い定義は再コンパイルする。query内だけの修正ならschemaIdは維持できるが、スキーマ内の`json()`でschemaIdが変わる保存済みDBには移行が必要となる。旧runtimeからのデータ取出しと新スキーマへの自動移行は今回追加していない。

バイナリ経路の利用例は[固定DDL＋prepared statement](predefined-binary.md#必要機能だけを含むビルド)を参照。`just measure-optional-functions`で、実際に動作する選択ビルドを[個別・一括の除去計測](../../measurements/optional-functions-current.json)へ保存する。以前の関数をthrowへ置き換えたサイズ試算とは別の測定である。

通常のJS bundlerだけでは、単一のSQL evaluator内部まで不要な分岐を判定できない。このAPIは隔離したMoonBit workspaceへ定数と公開exportsを生成し、Moonの到達性解析・定数畳込みで実装を除く。その後ESMのtree shakingで未使用exportsを除く。Wasmも同じプロファイルで生成する。実行中のフラグ切替ではサイズは減らない。

機能を外した際、対応するスキーマ・論理画像・事前コンパイル済みクエリは`feature disabled`で拒否する。SQLの文字列解析に依存せず、AOTをロードする段階でもASTとスキーマを検証する。主キー索引を外した場合は結果を変えず走査へ戻す。AOT版はSQLパーサを含まない。FTSと実験的LSMも通常の生成ランタイムへ含めない。

サイズは[プロファイル計測](../../measurements/p0-before/sqlike-feature-profiles-current.json)を参照。実装を外した生成物と全選択の生成物を比較し、trigger本体、FK参照動作、STRICT型検査、USING、PK mapの実装が除去されたことも検査する。小さな失敗通知やno-opの補助関数は残ることがある。サイズはエンジン単体で、host adapter・catalog・永続化・HTMLを含まない。

## RIGHT/FULL JOIN・STRICT・主キー索引

RIGHT/FULLは、ONで一致した右行を追跡して、未一致行をNULL補完する。WHEREは補完後に適用する。USING/NATURALの統合キー、修飾列・star、異なる型の列の比較もnative差分テストで検査する。未指定ORDER BYの行順は保証しない。

STRICTは`INT/INTEGER/REAL/TEXT/BLOB/ANY`を許可し、通常のaffinityによる変換後に保存クラスを検査する。STRICT ANYは文字列`'000123'`を数値に変換しない。失敗した複数行変更やUPDATEは文全体を戻す。datatype違反は`OR IGNORE`やtriggerのconflict overrideでも無視しない。SQLite画像、AOT、論理画像でもSTRICTメタデータを保持する。

PK索引は画像に保存しない派生状態。読み取り・一意制約検査で必要になったテーブルについて構築し、通常DMLは差分更新する。schema変更・restore・rollback用cloneからは共有しない。最大4テーブル分を保持し、再構築可能にする。NULLを許す通常表のPK、NOCASE/RTRIM、数値比較、WITHOUT ROWIDの扱いは残余predicateと既存評価器に従う。索引は行参照のmapを追加するため、検索速度と保持メモリの交換条件がある。UPDATEの行位置はslot mapから解決し、checkpointは変更表だけ行配列をcopyする。変更表の配列コピーとDELETEはO(N)である。

## trigger/FK付きbinary同期

```ts
import * as runtime from './generated/sync/runtime.js';
import {openSql} from './src/sqlike-runtime.ts';
import {withMaterializedReplication} from './src/materialized-replication.ts';
import {SyncEngine} from './src/engine.ts';

const db = withMaterializedReplication(openSql(runtime));
const authority = new SyncEngine(db);
```

全機能版の`MoonDatabase`、`NodeDatabase`、`WasmDatabase`にも同じwrapperを適用できる。wrapperをimportしない通常経路へ抑制実装は追加しない。`binarySync`のないSQLランタイムには`capture`を公開せず、SQL-onlyとして扱う。

受信側は以下を一つのトランザクションで行う。

1. schema・世代・old valueと利用側のbefore条件を検証する。
2. user triggerを定義順ごと退避して除き、FKの検査・参照動作を停止したscopeで、changesetに含まれる副作用の結果も適用する。
3. triggerを同じ順で復元し、全体の`foreign_key_check`を検査する。
4. 論理schema署名が変わっていないことを確認して物理schema cookieだけ追従する。論理世代は増やさない。
5. 利用側のafter条件とreceiptを同じトランザクションで確定する。ACK喪失後はreceiptで再適用を防ぐ。

例外時はデータ・trigger DDL・cookie・receiptをまとめて戻す。途中の例外を呼出側が捕捉しても部分適用をcommitできない。SQLiteではFK停止をBEGIN前に行い、connection設定をfinallyで戻す。FK設定が画像の一部であるSQLikeはdriver所有scopeで切り替え、検査を停止した画像を永続化しない。

Node 24、SQLike、ChromiumのSQLite WASMで双方の送受信を検証した。Turso/DOでは同等の抑制能力を保証しない。FK停止が許可されないdriverや既存SQLiteトランザクション内では、変更前に明示的に拒否する。この場合は既存のSQL同期を使用する。`recursive_triggers=OFF`だけを副作用抑制として扱わない。

**binaryモードは元のSQLを再実行してtriggerの意味を証明するものではない。** 送信元は全user tableの非NULL PKと、副作用を含む完全な捕捉が必要。FK整合性・old valueに加え、監査表の完全性や業務条件は利用側の`ApplyPolicy.before/after`で記述する。曖昧なときの`onAmbiguous`、defer/reject/明示的な置換SQLという既存契約も維持する。任意の不完全・改ざんchangesetが正しいtrigger結果であることまでは保証しない。

[差分テスト](../../tests/sqlike-outer-strict.test.ts)、[PK索引](../../tests/sqlike-primary-index.test.ts)、[機能除去](../../tests/sqlike-feature-profiles.test.ts)、[binary同期・復元](../../tests/materialized-sync.test.ts)、[SQLite WASM E2E](../../e2e/materialized-sync.spec.ts)。


検証はMoonBit 41件×JS/Wasm、Node 207件、Playwright 44件を通過した。全SQLite機能監査の固定probe一致は162→166件、candidate-errorは190→186件、値不一致は0件。未対応API・未検証の機能は残るため、全互換監査ゲートのexit 1は維持し、SQLite全機能互換や0.1.0達成とは扱わない。


[追加差分監査の修正結果](sqlite-differential-findings.md)では、STRICTの変換、USING、NOCASE/PKなど12項目を修正し、566ケース×8経路を通過した。全機能監査の固定probeは170件一致、candidate-error 182件、値不一致0件。全機能互換の未達判定は維持する。
