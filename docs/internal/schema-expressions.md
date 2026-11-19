# 式DEFAULTとCREATE TABLE AS SELECT

2026-11-18、未公開の作業ツリー。[SQLite CREATE TABLE](https://www.sqlite.org/lang_createtable.html)とNode組込SQLiteを基準に、動的SQL・JSON AOT・binary definedをJS / Wasm GCで比較する。

## 式DEFAULT（S06a）

```sql
CREATE TABLE item(
  id INTEGER PRIMARY KEY,
  title TEXT DEFAULT(lower('UNTITLED') || '-draft'),
  n INTEGER DEFAULT((1+2)*3),
  created TEXT DEFAULT(datetime('now'))
);
```

括弧付きの算術・比較・CASE・CAST・対応済みscalar関数を利用できる。列参照、bind、subquery、集約・window関数は宣言時に拒否する。括弧内のidentifier引用も保守的に拒否するため、関数名・CAST型名の引用は未対応。括弧外のbare wordと引用識別子はSQLiteと同じTEXT literalとして扱い、単純値の後のCOLLATEは列の属性にする。

不足列だけを各行で評価し、明示値・明示NULLがある列のDEFAULTは評価しない。`last_insert_rowid()`は直前までの挿入を、`changes()`は前の文の変更数を参照する。DEFAULTは行やtriggerのNEW / OLDを参照しない。NOT NULLのOR REPLACEとFK SET DEFAULTも同じ評価器を使う。式の失敗は既存の文単位rollbackに従う。

clockはhostが文ごとに設定し、同じ文の各行で同じ時刻を使う。保存するのは評価済みの値。JSON / binary snapshot・SQLite画像・LTXで値を再評価しない。SQLite画像の完全なrecordにある値も、読込時にDEFAULTで上書きしない。

ALTER ADDの式DEFAULTは空tableだけで受け入れる。既存行へのbackfillはliteralに限り、日時等の式を拒否する。catalogのDEFAULTにしか使わない関数も依存解析へ含める。

## CTAS（S06bの初期範囲）

```sql
CREATE TABLE initial AS
SELECT CAST(1 AS INTEGER) AS id, lower('HELLO') AS title;
```

列のaffinityからINT / REAL / NUM / TEXT / 空の宣言型を作り、PRIMARY KEY・制約・DEFAULT・collationを引き継がない。結果順に1からrowidを付ける。評価が全件成功してからtableを公開する。動的SQLのbind・通常のSELECT / JOIN / CTE・transaction rollback・保存後の再開に対応する。

保存用SQLは元のSELECTではなく、SQLiteの[build.c](https://github.com/sqlite/sqlite/blob/master/src/build.c)に従う正規化したCREATE TABLEにする。引用と短文 / 改行の境界も比較する。重複列名の`:1`〜`:4`は決定的に生成するが、それより先の衝突でSQLiteが乱数を使う入力は拒否する。compound SELECTからのaffinity継承はネストやview内も含めて拒否する。列は2,000、初期行は100,000まで。他の共通resource limitも適用する。

固定catalogではCTASをビルド時に実行し、初期行を定義へ格納する。初期化専用のSELECT・パーサ・JSON関数は実行側へ持ち込まない。日時関数・CURRENT_*・接続counter・乱数を使うCTASはビルド時に拒否する（固定日時引数の関数も現時点ではこの制限に含む）。

初期行は接続ごとに複製する。snapshotがあればその行集合で置き換え、初期行を再挿入しない。初期行を削除してIndexedDBをofflineで開き直す経路も検査する。

## binary定義の追加種別

空schemaはSQLK version 1 / kind 1を維持する。初期行ありのschemaはkind 7とし、typed payloadを`Store`、続いて`Array[Array[StoredRow]]`の順に格納する。内側の配列はtableの宣言順、各配列は保存順。table数の一致、少なくとも1行、行幅・rowid・型・制約を公開前に検査する。SHA-256・feature bits・1 MiB上限は既存containerと共通。schemaIdは初期行を含む全containerを識別する。

従来readerはkind 7を拒否する。kind 1のpayloadへ行を追加して読み捨てさせない。JSON AOTも定義内の検証済み初期行を読み込む。既存の空schemaの形式は変更しない。

## DEFAULTの評価コスト

`just measure-defaults`は100行のprepared INSERTを5,000 / 100,000行まで繰り返す。bind生成は計測外、各条件1回warmup後の3回中央値。M5 / Node 24、永続化なし。SQLiteとのtransaction条件は同一ではないため、DB一般の速度比として扱わない。

| 100,000行 | literal中心・変更前 | literal中心・変更後 | 算術DEFAULTあり・変更前 | 算術DEFAULTあり・変更後 |
| --- | ---: | ---: | ---: | ---: |
| JS | 260.97 ms | 197.55 ms | 270.62 ms | 217.57 ms |
| Wasm GC | 118.90 ms | 94.35 ms | 127.65 ms | 104.26 ms |
| Node SQLite | 9.60 ms | 9.68 ms | 9.71 ms | 10.01 ms |

NULL・literal・truth literalで評価用データを生成しないようにした。[変更前の記録](../../measurements/sqlike-default-performance-before.json)と[現在の測定](../../measurements/sqlike-default-performance-current.json)を残す。上表は最適化の直前・直後の比較で、後続のソース変更後の再計測と混ぜない。

残りはCTASのcompound affinity・乱数を伴う名前解決・固定日時初期化の判定、およびDEFAULTの追加関数。SQLite全機能への対応完了を意味しない。
