# DELETEとrowid順cacheの更新

2026-11-17。基準はmainの`b510904`（実装HEAD `fe98120`）。以下はDELETE改善を導入した`64eb250`時点の固定記録。前回の大量書込試行で残ったDELETEを、cacheなし・cacheあり・削除後に毎回読取の3条件へ分けた。

## 原因と変更

主キーlookupと行ストアは既に索引・COWページを使っていたが、rowid順の読取cacheは10万行でもflatな配列だった。これを一度構築するとDELETEのたびに後続の行参照を移動する。cacheを構築しない条件との速度差と、別採取のCPU profileで配列の`unsafe__blit`が支配的だったため、今回の変更はこのcacheに絞った。

rowid順cacheも大きい二次索引と共通の`IndexRows`を使い、8,192行以下はflat、超えたら128行のleafへ分ける。256行超でsplitし、小さいleafは隣接mergeする。行値は共有し、leafへ保存するのは行参照。削除時の行参照移動をleaf内へ抑える。prefix位置の更新はleaf数に比例するため、完全なO(log N)の木ではない。

全件読取が行ごとにleafを二分探索しないよう、queryのrange走査も変更した。最初のleafだけを探索し、以降はleaf内のslotと次のleafへ順次進む。逆順のsecondary range・OFFSET・残余条件による読み飛ばしも同じ走査を使う。既存の集約はleaf内の直接走査を継続する。

DELETEの候補判定・制約・FK・trigger・RETURNING・counter・statement backupは維持した。保存画像・Program・LTX・同期journalの形式と公開APIも同じ。mutable cacheをtransaction checkpoint / cloneへ共有せず、rollback後は元の行ストアから再構築する。

## 計測

<!-- delete-results:start -->
2026-11-17、Apple M5 / Node v24.22.2 / SQLite 3.53.4、3回の中央値。10万行のµs/cycle。

| 条件 | JS 前→後 | Wasm 前→後 | SQLite |
| --- | ---: | ---: | ---: |
| cold | 4.36→4.90 | 2.96→2.95 | 0.57 |
| warm | 188.36→5.22 | 50.30→3.24 | 0.55 |
| delete-read | 225.87→34.28 | 67.70→14.38 | 4.11 |

DELETE後の10万行に対する全件read（残り99,000行、ms、JSON / 型変換込み）:

| 条件 | JS 前→後 | Wasm 前→後 |
| --- | ---: | ---: |
| cold | 59.21→60.38 | 49.76→44.74 |
| warm | 54.39→54.39 | 43.76→44.10 |
| delete-read | 62.09→55.80 | 44.19→43.80 |

小さい表のwarm DELETE（µs/cycle）:

| 行数 | JS 前→後 | Wasm 前→後 |
| --- | ---: | ---: |
| 1,000 | 9.41→8.99 | 5.67→4.70 |
| 10,000 | 21.88→6.86 | 4.36→3.75 |

同じexport集合を持つengine単体のBrotli容量:

| engine | 前 | 後 | 増分 |
| --- | ---: | ---: | ---: |
| AOT + SQLite writer + LTX | 113,076 B | 113,321 B | +245 B |
| SQLike dynamic SQL | 120,694 B | 120,768 B | +74 B |
| Litestream | 38,291 B | 38,291 B | +0 B |

135 samplesを全て完走・native照合した。beforeのraw artifact hashは基準commitの記録とも一致した。全件read・小DBは改善率を保証する対象にせず、生値を併記する。
<!-- delete-results:end -->

Node 24のmemory DBで、JS / Wasm GCと`node:sqlite`を比較する。ブラウザ・IndexedDB・disk commitの計測ではない。

| 条件 | 計時前 | 1 cycle |
| --- | --- | --- |
| cold | ordered cacheを作らない | prepared DELETE |
| warm | ORDER BY id LIMIT 10を一度読む | prepared DELETE |
| delete-read | 同上 | prepared DELETE＋ORDER BY id LIMIT 10 |

1,000 / 10,000 / 100,000行を別々に作り、各sampleで最大1,000件の偶数rowidを削除する。3回の中央値、エンジン順を回し、各呼出しの間で3秒予算を確認する。DELETEはmissで事前prepare、readは両方ともuncached SQL APIを使う。初期化・native SQLite画像のimportは計時外。nativeとの型付き全行照合と`changes()`をsample後に検査する。末尾の全件readはJSON / 型変換を含み、coldではcache初回構築も含む。

CPU profileは10万行から1万件削除する別runで採取する。profilerの起動・dispatchの費用もsampleされるため、benchmark時間や厳密なフェーズ比率として扱わない。短い時間の差や異なるABIの差を、汎用的な改善率として扱わない。

```sh
just delete-bench
just delete-bench --smoke
# 同じMoonBit版で基準commitをbuildし、sqlike.js / sqlike.wasmを保存しておく
just delete-bench --before-dir=generated/delete-before --profile
```

[導入時のraw report](https://github.com/mizchi/sqlike/blob/64eb250/measurements/delete-current.json)へsource / artifact / CPU profileのhash、実行時間・件数・native照合の結果を残した。[現行レポート](../../measurements/delete-current.json)は後続のAOT native等も含む再計測で、固定記録と区別する。既存の大量INSERT / DELETEとChromiumの8経路も再計測する。

## 検証と残課題

大きいrowid cacheのleaf上限を先にテストしてRedを確認した。JS / Wasmで削除後の行順・範囲・逆順secondary index・OFFSET / residual、主キー移動・挿入、trigger、副作用の途中失敗、SAVEPOINT / rollback、空表・再挿入、同期deltaの再適用をnative SQLiteと照合した。

全回帰はMoonBit 68件×JS / Wasm、Node 398件、Chromium 59件を通過。対応済み差分566ケース×12経路の不一致は0。P0計測・README画像と表・source / artifact hashの検査も通過した。

cacheなしのDELETEにもSQLikeとSQLiteの差が残る。次の候補はDELETEのprepared metadataと行Environment・制約 / trigger探索の固定費であり、今回は索引以外の意味処理を変更しない。順次走査の導入に伴う小さい問い合わせ・全件readの値も記録し、全クエリが速くなったとは判定しない。
