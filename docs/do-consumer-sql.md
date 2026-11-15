# C02のDO対応: CTE、列RETURNING、metadata

このページの件数・速度・容量はC02実施時点の記録。Drizzle対応前の[固定した計測](../measurements/drizzle-before)を参照する。現行の決定的RETURNING式・bind、排他migrationとtrigger導入は[Drizzle](drizzle.md)に記録した。

2026-11-16。DO adapterで一律拒否していた`WITH`、列ベースの`RETURNING`、index / tableのmetadata PRAGMAを追加した。SQLiteの型をNumberから推測せず、失敗した変更を公開しない契約を維持する。C02全体では、SQLikeの集約代表行などの課題が残る。0.1.0に含める。

## 対応範囲

| 入力 | 今回の対応 | 残る拒否 |
| --- | --- | --- |
| CTE | 通常 / RECURSIVE、複数 / 入れ子、列名、MATERIALIZED / NOT MATERIALIZED。最上位のSELECT / VALUES / INSERT / REPLACE / UPDATE / DELETEを区別 | 不明なCTE構造、対応外の最上位文。SQLの詳細はDOのSQLiteが検査 |
| RETURNING | 宣言列・`*`・列の`typeof()` / `hex()`、AS / 暗黙alias。INSERT / UPDATE / DELETE、UPSERT、CTEとの併用 | 任意の演算・関数・subquery、bindの直接projection、暗黙rowidの名前解決。未知の式は0行対象でも実行前に拒否 |
| metadata | `index_list` / `index_info` / `index_xinfo` / `table_list`を追加。main等のschema指定、引用したPRAGMA名を処理 | `database_list` / `encoding` / `user_version` / `application_id`等は実workerd自体が禁止するため、adapterでも明示拒否 |
| 既存の境界 | positional bind、int64 / REAL、TEXTのNUL / BOM、BLOB、既存table / FK metadata | 名前付きbind・複数文・trigger本体の導入は引き続き拒否 |

例:

```sql
WITH selected AS (SELECT id FROM notes WHERE tenant=?)
UPDATE notes SET n=? WHERE id IN (SELECT id FROM selected)
RETURNING id,n;

INSERT INTO notes(id,title,n,payload) VALUES(?,?,?,?)
RETURNING id,title,typeof(n),n,hex(payload),payload;

PRAGMA main.index_xinfo('feed');
```

これはDOのホストadapterの拡張で、MoonBit SQLikeのSQL実装範囲やAOT Programの形式を変更しない。同期ワイヤのSQL検査・利用側policyは別の境界として維持する。

## 型を保った取得

[bind lexer](../adapters/do-bindings.ts)で得たtokenから、[構造の判定](../adapters/do-statement.ts)がCTEの括弧・AS・modifierを読み、最上位文を決める。引用文字列やコメント内のSELECT / UPDATEを最上位文と誤認しない。SQL全体の式解析器は追加せず、最終的な構文・名前・制約の検査はSQLiteが担当する。

CTEのSELECT / VALUESは既存の型付きmaterialized CTEへ流す。列名取得の実行と型付き取得の2回があり、SELECTの再評価は残る。CTE付きDMLはその読み取り経路へ流さず、一度だけ実行する。末尾の`; -- comment`がworkerdで複数文扱いされるケースは、lexerが確認した最後のセミコロン以降を除いてから渡す。

[RETURNING変換](../adapters/do-returning.ts)は、書込対象の`pragma_table_xinfo`を同じtransactionで読み、列と出力名を確定する。列参照と、その列だけを引数に取る`typeof` / `hex`に限定して、RETURNINGへ型と値のprojectionを付ける。DML自体を列名取得のために実行したり、結果取得のために再実行したりしない。[SQLiteのRETURNING](https://www.sqlite.org/lang_returning.html)の変更前後の値と副作用をそのまま取得する。

INTEGERは十進TEXT、TEXTはhex、REAL / BLOB / NULLは元の値でDO境界を越える。列の格納クラスをNumberの整数判定で推測しない。任意の関数やsubqueryは、型用・値用の評価が同じ値になると証明できないため、変更前に拒否する。識別子のcase比較はSQLiteに合わせてASCIIだけを折り畳み、`"Ü"`と`"ü"`も区別する。

結果のTEXTを厳密なUTF-8として復号できない場合は、transactionをrollbackし、全結果を公開せずに拒否する。表とtriggerの副作用の取消を検査した。接続の`changes()`等まで元へ戻す処理は設けない。ここはSQLiteのrollback後の接続カウンターに従い、未知のRETURNING式を実行前に拒否するケースと区別する。

## 実DOでの差分

[固定consumer SQL](../tests/compatibility/do-consumer-cases.ts)、[Node上の型を失うDO境界の再現](../tests/do-consumer.test.ts)、[隔離した実workerd](../e2e/do-consumer.spec.ts)を用意した。[当時の結果](../measurements/drizzle-before/do-consumer-current.json)は6シナリオ・51ステップ、30一致・20明示拒否・1件の双方制約エラー。リンク先のテスト・実装にはその後の拡張も含む。

- int64上限と2^53を超える主キー、整数値REAL、NULL、BLOB、TEXTのNUL / BOMをnative SQLiteと比較。
- CTE＋RETURNING付きDMLを含むINSERT / UPDATE / DELETEと、triggerの一度だけの実行を比較。制約失敗・未知の式・壊れたTEXT・複数文の後にも表と監査表を照合。
- 成功時の`changes()` / `last_insert_rowid()`、初期値からの`total_changes()`増分を比較。DOには内部初期書込があるため、absoluteなtotal_changesの初期値はNodeの空DBと一致すると仮定しない。
- DOは`sqlite_version()`も許可しない。版を推測せず、取得拒否の実際のエラーを結果へ記録する。

trustedなfixture bootstrapだけは、native DO SQLでtriggerを準備する。このテストをもって、公開adapterでtrigger本体DDLの導入を対応済みとはしない。DOのSQL操作と同期transactionには[公式storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)を使う。

## 費用と再現

Apple M5 / Node 24.22.2 / wrangler 4.162.0、local workerd、1,000行。同じ値へのUPDATEを7×10,000回、raw / typedの順を交互に計測。PK・UPDATE / RETURNINGのparamsはbigintを使う。Numberのparamsを増やす場合はREAL bindの検査回数も増える。HTTP・bootstrap・プロセスメモリは含まない。raw APIは整数／REALの型を失うため、同じ互換性の実装とは扱わない。[当時の測定全量](../measurements/drizzle-before/do-speed-current.json) / [着手前](../measurements/c02-before/do-speed-current.json)。

| 問い合わせ | raw / typed µs | typed SQL API回数 |
| --- | ---: | ---: |
| PK検索 | 2.7 / 16.1 | 2 |
| REAL bind×2 | 2.7 / 23.0 | 4 |
| UPDATE | 2.3 / 5.2 | 1 |
| CTE PK検索 | 2.6 / 18.8 | 2 |
| UPDATE RETURNING id,n | 7.4 / 20.7 | 2（metadata＋DML） |

着手前のtyped PK検索15.6µs、REAL 22.6µs、UPDATE 4.6µsに対して固定費は増えた。rawも2.6 / 2.6 / 2.2µsから変動しており、この測定を速度改善とは扱わない。CTE構造とRETURNINGの検査を加えた費用として残す。

MoonBitのJS / Wasm、notes Program、ブラウザの配信assetはR02時点のhashと一致する。ブラウザ転送量はAOT 116,300 B（113.57 KiB）のままで、今回の機能はDO側に置く。SQLike / IDB / ブラウザサイズの既存計測は、入力・成果物のhashが一致する記録を維持し、DOの速度を再採取した。LSM / FTSを通常バンドルへ追加していない。

```sh
just do-consumer-check
just do-bench
LITESTREAM_BIN=/path/to/litestream just check
just differential-audit
pnpm exec tsx scripts/check-p0.ts --record
```

C02の残りはSQLikeの集約代表行など。DOの任意RETURNING式と、ホスト自身が禁止するPRAGMA、Tursoのbind能力を、今回の成功範囲へ合算しない。
