# SQLと値の扱い

```ts
import { openDatabase } from '@mizchi/sqlike';
const db = openDatabase();
db.run('CREATE TABLE task(id INTEGER PRIMARY KEY,title TEXT,score REAL,payload BLOB)');
db.run('INSERT INTO task VALUES(?,?,?,?)', [1n, 'hello', 2.5, new Uint8Array([0, 255])]);
const rows = db.all('SELECT id,title,score,payload FROM task WHERE id=?', [1n]);
```

`openDatabase()`はインメモリの接続を返します。SQL文は`?`等のbindを使って値を渡せます。

## 接続のAPI

| API | 動作 |
| --- | --- |
| `run(sql, params?)` | 結果行を受け取らず実行 |
| `all(sql, params?)` | 列名をキーとするオブジェクトの配列。RETURNINGも使用可能 |
| `values(sql, params?)` | 列位置順の二次元配列。同名の結果列を保持 |
| `query(sql, params?)` | 書込を拒否する読み取りAPI |
| `transaction(body)` | 同期callbackを原子的に実行。例外時はrollback |
| `savepoint(body)` | transaction内の変更をまとめ、失敗した範囲をrollback |
| `dump()` | 再開用のSQLike画像を文字列で取得 |
| `close()` | 接続を閉じる |

transactionのcallbackは同期関数です。`async` callbackやPromiseを返す使い方は扱いません。

`dump()`はSQLike独自の保存形式です。SQLiteファイルを書き出す場合は[固定schemaのSQLite出力](prepared.md#sqliteファイルへ書き出す)を使います。

```ts
const image = db.dump();
db.close();
const reopened = openDatabase(image);
reopened.close();
```

## 値の型

| SQL | JavaScript / TypeScript |
| --- | --- |
| NULL | `null` |
| INTEGER | `bigint` |
| REAL | `number` |
| TEXT | `string` |
| BLOB | `Uint8Array` |

bindでは`1n`がINTEGER、`1`がREALです。INTEGERを`number`へ丸めずに扱うため、整数の主キーや大きな整数には`bigint`を使います。結果も格納クラスに応じて返します。

## SQLの対応範囲

| 分野 | 対応する主な機能 |
| --- | --- |
| 更新 | INSERT / UPDATE / DELETE、複数VALUES、INSERT SELECT、UPSERT、RETURNING |
| 検索 | SELECT、WHERE、DISTINCT、ORDER BY、LIMIT / OFFSET、複合SELECT |
| 結合 | INNER / CROSS / LEFT / RIGHT / FULL、ON / USING / NATURAL |
| 集約 | GROUP BY / HAVING、COUNT / SUM / TOTAL / AVG / MIN / MAX、group_concat等 |
| 問い合わせの構成 | CTE、再帰CTE、subquery、CASE、CAST |
| schema | 通常テーブル、PRIMARY KEY、UNIQUE / 部分 / 式index、STRICT、基本ALTER |
| 制約 | NOT NULL、CHECK、外部キー、対応範囲のCASCADE / SET NULL等 |
| trigger | 通常テーブルのBEFORE入力検証、AFTER INSERT / UPDATE / DELETE、OLD / NEW、WHEN、RAISE(ABORT / IGNORE) |
| 関数 | 基本scalar関数、対応範囲のJSON・日時・window関数 |

各構文・関数の全入力を受理するものではありません。SQLiteの全PRAGMA、仮想テーブル、任意拡張、独自関数・collation等は対応範囲外です。未対応のSQLはエラーにする方針です。

### 0.1.1の追加

基本ランタイムに`IS DISTINCT FROM` / `IS NOT DISTINCT FROM`、64bitの`&` / `|` / `~`、`sign()`を追加しました。NULL・型変換・collationもSQLiteと差分検証します。

JSONの`->`はJSONテキスト、`->>`はSQLの値を返します。JSON path・フィールド名・整数の配列indexを指定できます。これらは既存の`sqlJson`機能に含まれ、[選択ビルド](prepared.md)で`sqlJson`を省くとJSON実装を配信しません。未選択のランタイムへJSON演算子を含む定義を渡すと、未実行の式でも初期化時に拒否します。

```sql
SELECT NULL IS NOT DISTINCT FROM NULL; -- 1
SELECT 4294967296 | 1, ~0, sign(-2);   -- 4294967297, -1, -1
SELECT '{"n":1}' -> 'n', '{"n":1}' ->> 'n'; -- TEXT '1', INTEGER 1
```

その他の不足機能は[段階別の実装チェックリスト](internal/staged-sqlite-compatibility.md)で管理します。

### 0.1.1のその他の互換機能

| 機能 | 選択ビルドでの扱い |
| --- | --- |
| `LIKE … ESCAPE` / `like(pattern,text,escape?)`、複数引数のscalar `min/max` | core。NULL・型・collationを保持する |
| `GLOB` / `NOT GLOB` / `glob(pattern,text)` | core。大文字小文字を区別し、`*` / `?` / `[…]` / `[^…]`・Unicode範囲を扱う。patternは50,000 byteまで |
| `char(codepoint,…)` | core。NULを保持し、NULLはコード点0、範囲外はU+FFFD。サロゲート値は明示拒否 |
| `0xF_F` / `1_000`などの数値literal | SQL parserで既存のINTEGER / REALへ変換。文字列やbind値の数値変換には拡張しない |
| `ORDER BY … NULLS FIRST/LAST` | core。列番号・別名・windowのORDER BYにも対応 |
| `:name` / `@name` / `$name` | SQL解析時に位置へ解決。同じ名前は同じbind位置、大文字小文字・接頭辞は区別 |
| FROM内subquery | 既存CTE実行器を再利用。重複列名の自動改名は拒否するため、内側の列に一意な別名を付ける |
| `index_list` / `index_info` / `index_xinfo` PRAGMA | `schemaMetadata`。旧schemaから自動索引の番号・方向を確定できないケースは明示拒否 |
| 集約の`FILTER(WHERE …)` | `aggregateFilter`。通常 / DISTINCT / window集約に対応 |
| `json_group_array/object` | `sqlJson`。空集合・重複キー・subtypeを保持。BLOB値・NULLのobject label・JSON集約windowは未対応 |

```ts
db.values('SELECT :x,:x,@x', [1n, 2n]); // [[1n,1n,2n]]
```

SQL APIへ渡すbindは位置順の配列です。Drizzleのnamed placeholderをobjectで渡す用途には[事前コンパイルentry](drizzle-prepared.md)を使います。

```sql
SELECT 'image.png' GLOB '*.[a-z][a-z][a-z]'; -- 1
SELECT hex(char(65,0,233));                  -- '4100C3A9'
SELECT 0xFFFFFFFFFFFFFFFF,1_000;             -- INTEGER -1, 1000
```

GLOBとLIKEは最初のNULまでを照合します。`char()`が返すTEXTのNUL以降も値としては保持されます。16進literalは符号付き64bitの2の補数で解釈し、桁あふれは拒否します。数値literalの追加構文は事前コンパイル時に解決されるため、`defined` / `aot`のランタイムにSQL parserは不要です。

関数の引数は1,000個までで、上限超過は準備時に拒否します。

必要機能はバイナリcatalogにも記録し、機能を外したruntimeでは初期化時に拒否します。整数へ損失なく変換できるREAL / TEXTのLIMIT / OFFSETも受理します。内部IR用の`$`で始まる関数名と`in()`のSQLからの直接呼出しは拒否します。IN演算子のリストは関数引数の上限には含めません。

クエリ実行時には行データをメモリに保持します。IndexedDBへ保存する用途は[事前定義したSQL](prepared.md)を参照してください。
