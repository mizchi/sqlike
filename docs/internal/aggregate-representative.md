# MIN / MAXと集約のbare column

2026-11-18、未リリース。`aggregateRepresentative` query partを追加した。catalogの型付きIRから選択し、使わないAOT / definedから代表行の実装を除去する。baseline / fullでは有効。SQL parser・binary wireの追加はない。

```sql
SELECT category, id, title, max(score)
FROM items GROUP BY category;
```

[SQLiteの規則](https://sqlite.org/lang_select.html#bareagg)に従い、単一の組込みMIN / MAXで極値を持つ行のbare columnを返す。同じMIN / MAX式の繰り返しは一つとして扱い、COUNT / SUM等の同時利用も可能。HAVING、ORDER BY、windowの引数等に現れる参照も検査する。

## 一意性の契約

- 極値行が一つなら、その行を使う。
- 極値が同点の場合は、参照するbare columnの格納値・型・metadataがすべて等しければ受理する。列値がNOCASEで等しいだけでは不十分で、大文字小文字の異なる出力を勝手に選ばない。REALの符号付きゼロもbit単位で区別する。
- 全NULLのgroupでも、すべての候補について同じ検査を行う。空の入力では、bare columnをNULLにしたscopeを使い、pinned SQLiteの出力と比較する。
- 異なるMIN / MAXが複数ある場合、FILTER / DISTINCT / 引数内ORDER BY付きの代表行、volatile関数やsubqueryを使う極値引数は初期範囲外。MIN / MAXを伴わないbare columnも従来どおり拒否する。
- 一意に決められない場合は`unsupported ambiguous aggregate representative`。INSERT SELECT等は文全体を取り消し、部分的な書き込みを公開しない。

極値引数は代表行の判定と集約でそれぞれ評価するため、初期範囲を副作用のない列・literal・bind・基本演算・選択した純粋関数に限定する。random等を二回評価して異なる極値を返すことは避ける。ProgramはASTと参照列の情報だけを保持し、行・bind・Storeは実行ごとに評価する。

同点の全入力式が同じ結果になることまで証明する実装ではない。たとえば参照列値が異なっていても、`lower(name)`の結果が同じになるケースを現在は保守的に拒否する。HAVINGで消えるgroupの曖昧さも先に拒否する。

[6経路の差分・bind再実行・拒否後状態](../../tests/sqlike-aggregate-representative.test.ts)、[query partの推論・除去・無効runtimeでの拒否](../../tests/sqlike-query-profile.test.ts)を検査する。共有corpusもNode / Chromiumとoptimizer無効版で実行する。SQLite全般の任意代表行を再現する機能ではない。
