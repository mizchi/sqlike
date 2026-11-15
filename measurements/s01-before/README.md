# S01着手前の基準

`*-current.json`と`p0-completion.json`はP01完了時点の記録を固定したもの。
`indexeddb-blob.json`はS01のコード変更前に、同じ疑似乱数payloadをBLOBとして追加採取した。

`small-pair-0.json` / `small-pair-3.json`は変更前runtimeの再生成後の交互比較、`blob-memory-check.json`は自然なcheckpoint位相の診断、`blob-memory-matched.json`は先頭checkpointを揃えたprobe。`source.patch`を独立したsourceコピーへ`patch -p1`で適用しJS release buildすると、P01完了時のruntime SHA-256を再現できた。作業中のsourceへ直接適用しない。

過去のsource / artifact hashを保持する比較用の記録。元パスは現行ビルドへ更新されるため、このアーカイブを現行用の鮮度checkerへ渡さない。

[形式・計測範囲](../../docs/column-delta.md)を参照。
