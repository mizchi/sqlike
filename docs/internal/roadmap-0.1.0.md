# 0.1.0 の対応範囲と受入条件

[現在の対応・実施済み最適化と改善台帳](status-and-improvement-plan.md)を実装状態の入口とする。このページはU01〜U09のリリース受入条件を管理する。チェックボックスはシナリオ全体の受入で更新し、個別機能の実装有無とは区別する。

2026-11-15、[必須受入プロファイル](release-acceptance.md)のP0を通過した。MoonBit各42件、Node248件、Playwright47件、本家Litestream復元・差分・現行計測hashの[完了証拠](../../measurements/p0-completion.json)を保存した。以下のチェックはこの範囲の技術的受入を表す。0.1.0の再検証と変更点は[リリースノート](../releases/v0.1.0.md)に記録する。

現在のバージョンを **0.1.0** とする。ルートの package.json、`mizchi/sqlike`、`mizchi/litestream`、AOT example とその依存指定を揃える。**0.1.0 は、下記の一般的なアプリのシナリオを動的 SQL / AOT・永続化・同期の必須プロファイルで検証したリリース**とする。SQLite の全機能互換は別の目標で、既存の[全機能監査](sqlite-feature-audit.md)も維持する。

LSM は引き続き実験専用で、0.1.0 の既定バックエンドや配信バンドルの対象にはしない。SQLike / AOT の既定の永続化は IndexedDB の行ジャーナル。ブラウザデモ全体の既定 engine は従来通り `sqlite` であり、SQLike のリリース番号とは区別する。

[一般アプリ向けの追加機能](sqlike-app-features.md)として、SQLトランザクション・CAST・複合SELECT / INSERT SELECT・JSON / UTC日時・複合FK・移行・集約 / window / 再帰CTEを追加した。全文検索は通常ランタイムに含めない任意モジュールとする。以下のU01〜U09は、組合せ全体の合格を別に管理する。

## 0.0.1 の確認済み範囲

| 項目 | 現在の状態 | P0以後の改善 |
| --- | --- | --- |
| CRUD・bind・型付き API・AOT | CAST・複合SELECT・INSERT SELECT・SQLトランザクション、アプリ単位の組合せ・失敗後状態を検証 | P01: prepared状態・境界処理の再利用 |
| 通常 / UNIQUE index | 複合列・ASC / DESC / COLLATE・部分 / 式 index の宣言、一意性、SQLite保存とアプリの組合せ | P03: 式indexの検索利用 |
| index による検索高速化 | 主キー専用hash / rowid→slot、列 index の等値 prefix＋範囲・前後方向・残余条件、部分 index の限定的な含意判定、増分更新 | 式 index の検索高速化、保持メモリとアプリ単位の検証 |
| trigger | 型付きAST・基本triggerと、STRICT / index / FK付きアプリの失敗・復旧・同期を検証 | BEFORE書込等は未対応。機能範囲は別記 |
| IndexedDB | 行差分・世代CAS・再起動・trigger replay・ACK消失・実abortを共通schemaで検証。あり/なしのメモリも比較 | S01: 変更列差分、P02: 変更表コピーの削減 |
| SQLite / LTX | U09を含む非DDLシナリオのJS/Wasm画像、native integrity / FK、実Litestream復元を検証。[R02](aot-ltx-upload.md)でNode relay / DOへの送信・ACK消失後の再送も検証 | S02: 増分pager。複数writerの物理mergeは対象外 |
| SQL / Session 同期 | 共通アプリをNode / SQLike正本のSQL/binaryで検証。SQLite WASMも任意wrapperで副作用抑制を検証。portable profileはDO / Tursoを含むE2Eを維持 | DO / Tursoの拒否契約は受入表に明記。R02の物理履歴保存とは独立 |

index の「宣言・一意性が正しい」と「検索で index を使う」は別に管理する。高速化の前提を証明できない問い合わせは、既存の走査・評価経路へ戻す。最新の[実装範囲と検証](sqlike-index-trigger.md)、経緯は[二次索引](sqlike-secondary-index.md)と[増分更新](sqlike-incremental-index.md)を参照。

## 一般的な利用シナリオ

機能名だけをチェックせず、各行について固定SQL・データ・失敗入力・復旧手順を用意した。P0で[必須プロファイル](release-acceptance.md)を通過した。全driverの全SQLを受理する判定へは広げない。

| ID | アプリの利用例 | 0.1.0 で通す条件 |
| --- | --- | --- |
| U01 | メモ・タスク・設定の CRUD | prepared bind、NULL / INTEGER / REAL / TEXT / BLOB、UPSERT、RETURNING、制約違反後の状態 |
| U02 | テナント別一覧・更新順フィード | 複合 index `(tenant_id, updated_at, id)`、ASC / DESC、LIMIT、keyset pagination、同値・NULL境界 |
| U03 | 親子データ・タグ・集計 | JOIN、外部キー、複合 UNIQUE / FK、削除・更新時の参照動作、GROUP BY / HAVING、複数行変更 |
| U04 | 論理削除・一意な表示名 | 部分 UNIQUE index、復活・削除・再挿入、NOCASE、式 index の正規化キー |
| U05 | 監査ログ・集計カウンタ・入力検証 | 基本 trigger、OLD / NEW、WHEN、UPDATE OF、同一文の失敗、batch と再起動後の副作用 |
| U06 | ローカルキャッシュ・JSON設定・日付の検索 | 利用する関数の入力を固定する。最初の対象は `json_valid` / `json_extract` / `json_set`、`date` / `datetime` / `strftime` / `unixepoch`。NULL、UTC、境界値を照合 |
| U07 | スキーマ移行とトランザクション | CREATE / ALTER / DROP、index / trigger の維持・無効化、transaction API と基本 BEGIN / COMMIT / ROLLBACK / SAVEPOINT、旧画像の読込 |
| U08 | オフライン更新と再接続 | IndexedDB durable 保存、再起動、複数接続の古い書込拒否、ACK 消失、重複排除、競合の保留と利用側ポリシー |
| U09 | SQLite との受け渡し | index / trigger を含む schema とデータの SQLite 書出し・再読込、native の integrity / FK 検査、LTX 生成・復元 |

任意の ORM 全体が動くとは宣言しない。特定 ORM の対応を表明する場合は、そのバージョン・生成 SQL・migration を別の consumer scenario として追加する。FTS / 任意拡張・C ABI 全体・SQLite の全 PRAGMA は、この0.1.0の完了条件に含めない。未対応は黙って無視せず拒否し、対応表に残す。

Drizzle 0.45.4 / Kit 0.31.11は[独立したconsumer検証](drizzle.md)を追加した。RETURNING・UPSERT・JOIN・nested transactionと、生成6本＋custom 2本のmigrationを対象とし、relational query / AOT専用driver等は対応範囲へ含めない。

## index の実装順

1. **複合列・ASC / DESC / COLLATE の schema 表現**を定義する。DDL、dump / restore、AOT artifact、SQLite writer を同時に扱う。
2. **主キー / 複合 index の実行用構造**を追加する。先頭列の等値＋次列の範囲、前後方向の走査、残余 WHERE、LIMIT を検証する。index の有無で値・型・結果が変わらないことと、高速化を別に確認する。
3. **部分 index**を追加する。対象行の出入り、部分 UNIQUE、NULL、UPDATE / UPSERT / REPLACE / cascade / rollback を検証する。planner が利用条件を証明できない問い合わせは走査に戻す。
4. **式 index**を追加する。既定の deterministic な式に限定し、依存列の変更、collation、一意性、永続化、native SQLite の読取を検証する。

SQLite の index は列・式・WHERE による部分 index と、列ごとの順序・collation を持つ。一意性では NULL の扱いも一致させる。[公式 CREATE INDEX](https://www.sqlite.org/lang_createindex.html)を仕様とし、対応する native 差分で Red → Green を進める。

## trigger の実装範囲と順序

0.1.0 の必須範囲を、通常テーブルに対する **AFTER INSERT / UPDATE / DELETE**、**BEFORE の入力検証**、**OLD / NEW・WHEN・UPDATE OF・FOR EACH ROW・CREATE / DROP TRIGGER**、**RAISE(ABORT) / RAISE(IGNORE)** とする。これで監査ログ、別表のカウンタ更新、値の検証を扱う。INSTEAD OF による view 更新、TEMP / ATTACH、RAISE(FAIL / ROLLBACK) を含む残りの範囲は、0.1.x以降の拡張として未対応を明示する。

1. trigger のイベント・条件・本体を**型付き AST**にする。compiler が trusted schema を解析して artifact に保存し、AOT runtime では SQL text を再 parse しない。
2. DML の実行文脈に OLD / NEW と trigger frame を追加する。副作用は親の文と同じ候補状態へ適用する。`RAISE(ABORT)` は文全体を戻し、`IGNORE` と取り違えない。
3. 再帰の可否・深さ上限・エラーを明示する。`changes()` と `last_insert_rowid()` の trigger 前後の文脈、RETURNING、UPSERT / REPLACE、cascade との組み合わせを native と照合する。
4. dump / restore、IndexedDB replay、schema 変更、SQLite writer、LTX までつなぎ、副作用を含めた状態を確認する。

SQLite は行ごとに trigger を実行し、BEFORE / AFTER、OLD / NEW、WHEN に意味がある。対象行を自身で書き換える BEFORE trigger には本家でも未定義のケースがあり、その挙動まで独自に保証しない。[公式 CREATE TRIGGER](https://www.sqlite.org/lang_createtrigger.html)。`changes()` と rowid の文脈はそれぞれ[changes の仕様](https://www.sqlite.org/c3ref/changes.html)、[last_insert_rowid の仕様](https://www.sqlite.org/c3ref/last_insert_rowid.html)に従う。

同期 API の単文 lexer が現在 `BEGIN ...; ...; END` を拒否する制約は、セミコロンの検査を緩めて解決しない。trigger の導入は事前コンパイル済み schema / trusted migration から始め、リモートからの DDL とトランザクション境界は別契約として設計する。

## trigger と同期を組み合わせる条件

ここは trigger 本体の実装とは別の必須工程とする。

- **元の SQL を再実行する経路**では、各 replica でその SQL による trigger を実行する。同じ操作の再送は receipt で除外する。時刻・乱数など結果が揺れる式は検証し、利用側の適用ポリシーを通す。
- **副作用を含めた行 after-image / changeset を適用する経路**では、それを DML として再適用して trigger を重ねて実行しない設計にする。外部 driver でその制御を実現できない場合は、trigger を含む schema のその経路を明示的に拒否する。
- **SQLite 画像 / LTX の適用**では行 DML を再実行しない。保存されたデータと schema を復元し、読込時に trigger の副作用を増やさない。

この危険性は推測だけではない。Node 24.22.2 / SQLite 3.53.4 で、監査表にも PRIMARY KEY を持つ AFTER INSERT trigger と、両表を capture した native Session changeset を、同じ trigger を持つ空 DB へそのまま apply すると、CONFLICT で apply が失敗する例を確認した。binary経路は任意の[副作用抑制wrapper](sqlike-feature-profiles.md)を追加し、wrapperなしでは拒否する。SQL と after-image 復旧には[二重発火・ACK 消失の回帰テスト](sqlike-index-trigger.md)を追加した。[Session の変更捕捉](https://www.sqlite.org/sessionintro.html)、[changeset apply](https://www.sqlite.org/session/sqlite3changeset_apply.html)と driver の実能力に基づき、経路を区別する。

`recursive_triggers=OFF` は replica apply 全体の trigger 無効化とは扱わない。SQLite の [DBCONFIG_ENABLE_TRIGGER](https://www.sqlite.org/c3ref/c_dbconfig_defensive.html)のような制御も、各 adapter が実際に提供するかを確認する。SQLike / native SQLite / Turso / DO が同じ抑制 API を持つと仮定しない。

## 0.1.0 のリリース条件

- [x] U01〜U09 の固定シナリオを用意し、必須 SQL・入力と期待結果、拒否する範囲を一覧化する。
- [x] SQLike の動的 JS / Wasm GC と AOT JS / Wasm GC で、native SQLite の型付き結果・列位置・順序・失敗後の状態を比較する。
- [x] Playwright で IndexedDB の再読込・中断・古い writer・複数接続、オフライン同期と ACK 消失を含めて通す。
- [x] index と基本 trigger を含む schema を、論理画像 / AOT artifact / SQLite / LTX の必要な各境界で検証する。
- [x] trigger の二重実行を防ぐ契約と driver capability を定義し、サポートする同期経路を検証する。
- [x] 0.0.1 の保存データ・artifact を読むか、明示的な移行・再コンパイルを要求するかを定義し、既存データを黙って別解釈しない。
- [x] 既存の互換性コーパス・回帰テスト・本家 Litestream 復元を維持し、未実装の全機能監査を成功扱いに変えない。
- [x] index / trigger あり・なしの実アプリの転送量、durable 更新、検索、保持メモリを同じ条件で計測し、差分を公開する。LSM は通常サイズから引き続き除外する。
- [x] 公開する Connection / Statement、storage・同期・policy の契約、エラー、制約、導入例を文書化し、外部 consumer を通す。

個別実装に加えて、V01 / C01 / R01の横断受入と基準採取を完了した。次の実装は[改善チェックリスト](status-and-improvement-plan.md)のP1から選ぶ。モジュール番号は0.1.0へ更新した。公開・再検証は[公開手順](releasing.md)に従う。

## 開発中のバージョン変更の記録

0.0.1 への設定変更後、MoonBit JS / Wasm GC の check と build、外部 consumer・既存 index の native 差分7テスト、TypeScript の型チェックを通した。これは index / trigger の追加実装や、上記の未完了シナリオの合格を意味しない。

以前の計測時にはモジュール metadata の version が0.1.0になっていた。今回0.0.1へ揃えたため、Wasm の custom `name` section に入る module version と成果物 hash が変わる。通常の SQLike / AOT / Litestream について、JS は同一バイト列、Wasm はその version label 以外が同一であることを確認した。過去の測定 JSON はその時点の記録として残し、次回の計測で現在の成果物 hash を採取する。


RIGHT/FULL JOIN・STRICT・主キー専用索引と、trigger/FK付きbinary適用の現在の範囲・機能選択APIは[機能プロファイル](sqlike-feature-profiles.md)に記録する。0.1.0の受入範囲は上記の必須利用シナリオとし、追加機能は改善台帳で管理する。
