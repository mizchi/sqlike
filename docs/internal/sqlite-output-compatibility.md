# 出力互換を優先する契約

SQLikeはSQLiteのサブセットとして、未対応をエラーにできる。成功を返す場合は、対応するSQLiteの値・格納クラス・NULL・列・指定した行順を保つ。分からない動作を別の意味で実行したり、検査していない結果を成功として返したりしない。

この方針は、全機能の実装率と分けて検査する。未対応による拒否は一致件数へ数えず、どのSQLを拒否したか残す。限られたコーパスの通過を、すべての入力についての証明とは扱わない。

## 受理と拒否

- 構文・名前・演算子・collation・集約スコープを準備時に検査する。AOTもロード時に同じ検査を通す。未知の演算子を別の演算へ、未知のcollationをBINARYへ読み替えない。
- 集約関数の外ではGROUP BYの式だけを受理する。裸の列から代表行を推測しない。MIN/MAXのある集約で代表列を返す形は保守的に拒否する。[SQLiteには専用のbare-column規則がある](https://www.sqlite.org/lang_select.html#bareagg)ため、単に先頭行を返す実装では互換にならない。
- SQLikeのTEXTはUnicode文字列。無効なUTF-8をU+FFFDへ置き換えて返さず、表現できないBLOB→TEXT変換を拒否する。BLOBのバイト列の読取りは保持する。UTF-16 DBのBLOB式・TEXT→BLOB変換は、符号化の来歴を保持できない範囲を拒否する。
- `PRAGMA integrity_check` / `quick_check`は未対応として拒否する。実検査なしの`ok`は返さない。生成SQLiteの検証には、本家SQLiteの実際のintegrity_checkを使う。[本家の検査内容](https://www.sqlite.org/pragma.html#pragma_integrity_check)と論理DBの簡易検査を同一視しない。
- 引数でしか決まらない拒否は、文全体をrollbackしてからエラーにする。結果は全行の処理が成功するまで公開しない。SQLite WASMでも、RETURNINGのTEXTを表現できなかった場合はsavepointへ戻す。

LIKEのNUL処理、`foreign_key_check(table)`の対象限定・存在検査、UTF-16 TEXTのhex、集約を引数に取るwindowの集約判定は、拒否で回避せず修正した。

## 宣言と返却境界

`PRAGMA table_info/table_xinfo`のDEFAULT値は、数値やNULLから再生成せず、SQLの元の宣言を保持して返す。`DEFAULT 1e2`と`DEFAULT 100.0`、DEFAULTの省略と`DEFAULT NULL`を混同しない。旧論理画像は検証時に宣言情報を派生cacheへ読み込み、画像の保存バイト列を変えない。

AOTで宣言情報が必要なカタログにはコンパイル時に情報を入れる。不要なカタログには入れず、通常のnotes programの形式とパーサ除去を保つ。宣言情報を持たない旧AOTカタログのtable_info等は、推測する代わりに再ビルドを要求する。

DBアダプターの`Value`契約はINTEGERが`bigint`、REALが`number`。整数値のREALも`number`であり、出力時にINTEGERへ付け替えない。SQLite WASMは実際のcolumn typeから取得し、TursoはsafeIntegersを有効にする。TEXTはNULとBOMを保持する。

DOはホストAPIがINTEGERとREALをともにNumberで返すため、SQLiteの`typeof()`で型を確定し、INTEGERは十進TEXT、TEXTはhexを経由して取得する。数値から格納クラスを推測しない。bigintのbindは十進TEXTからINTEGERに復元し、単項`+`でCASTのaffinityを除く。Number bindがREALになることも事前に検査する。[C02](do-consumer-sql.md)のCTE・metadataに加え、[Drizzle対応](drizzle.md)でRETURNINGの決定的なscalar式・演算・bindを拡張した。書込は一度だけ実行する。random・時計・接続counter・subquery・未知の関数は実行前に拒否する。名前付きbind、通常の複数文、許可一覧外のPRAGMAも拒否する。trigger本体はownerが渡したhash検証済みmigration scopeでのみ導入でき、ネットワークのSQL同期へは許可しない。

入力を作る既存の`pack()`と、DBから読んだ値を返す`packStored()` / `packResult()`を分けた。結果・snapshot・検証用の観測でREALを整数へ変換しない。同期Cellで表現できない非有限値・負のゼロは明示拒否し、クエリ返却用ResultCellでは専用トークンを使う。NumberのDB直接bindingはREAL、bigintはINTEGERで統一する。Turso SDKは整数値のNumberをINTEGERへ変換し、型指定bindingを公開していないため、この入力域を実行前に拒否する。INTEGERが必要ならbigint、整数値のREALならSQL literalまたはbigintを明示CASTする。内部のrevision・cookieもbigintとして渡す。入力フレームを作る`statement()` / `pack()`の従来の整数推論は別の契約として維持する。

## 継続検証

```sh
# 通常の回帰検査に出力互換ゲートも含む
LITESTREAM_BIN=/path/to/litestream just check

# 全機能の台帳を使い、出力互換だけを検査
just sqlite-output-check

# 対応済みコーパスでは拒否も退行とする
just differential-audit

# 未対応・未検証も不合格とする全機能監査
just sqlite-audit
```

`sqlite-output-check`は次を不合格にする。

- 成功した値・型・行の差、SQLiteが拒否するSQLの誤受理。
- 拒否後のデータ・schema・保存設定の変更。接続のchanges/last_insert_rowidはSQLiteの別契約として除く。
- 拒否の状態証拠の欠落。双方で期待したエラーが出ても、証拠がなければ許容しない。
- 内部例外を未対応として数えること、参照側の想定外エラー、空・重複・欠落・古いレポート。

成功するpositive controlも必須とし、全件拒否でゲートを通さない。missing API・未検証・参照ビルドにない項目は別集計で残す。観測したSQLの出力と拒否を検査するゲートであり、それらの未検証項目まで互換とするものではない。DMLの成功後の状態は既存の差分コーパスのobserver・変更系列、snapshot往復、同期E2Eでも照合する。

[拒否・出力のコーパス](../../tests/compatibility/output-policy-corpus.ts)、[JS/Wasm/AOTの検査](../../tests/sqlike-output-policy.test.ts)、[ゲート自身の失敗検査](../../tests/sqlite-output-gate.test.ts)、[格納クラスとsnapshot](../../tests/result-types.test.ts)、[DOの型とbind](../../tests/do-types.test.ts)、[ブラウザ返却境界](../../e2e/result-types.spec.ts)を回帰検査に加えた。既存の同期差分テストも`packResult()`で比較し、整数値のREALを双方でINTEGERへ変換して差を隠さない。
