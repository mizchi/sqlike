# リリース手順

`mizchi/sqlike` と `mizchi/litestream` は同じバージョンでMooncakesへ公開する。GitHubリポジトリは [`mizchi/sqlike`](https://github.com/mizchi/sqlike)（public）、ライセンスはMIT。npm向けの2パッケージと初回公開手順は[npm配布](npm-release.md)を参照。ルートnpmパッケージはデモ・検証用のprivate設定を維持する。

1. ルート `package.json`、両モジュールの `moon.mod`、`examples/aot/moon.mod` とその依存指定、外部consumerの依存指定を更新する。変更履歴とリリースノート、現在の対応表を更新する。
2. `pnpm install --frozen-lockfile` と `moon update` を実行する。Node.js 24以上、MoonBit、Playwright Chromium、本家Litestreamを用意する。ライセンスとrepository metadataを確認する。
3. `just p0-measure` で逐次再計測する。バージョンだけの変更でもsource / Wasm artifactのhashが変わるため、古い報告のhashを書き換えて済ませない。
4. `LITESTREAM_BIN=/absolute/path/to/litestream just p0-check` を通す。MoonBit JS / Wasm、Node、型、配信ビルド、Chromium E2E、SQLite出力監査と差分、計測の鮮度を確認し、完了証拠を保存する。全SQLite機能監査の未達は維持する。
5. `just release-pack` で両モジュールのdry-runを通し、ZIP内にREADME・LICENSE・公開APIと実装があり、生成物や依存キャッシュを含まないことを検査する。ZIPを展開したモジュールでも外部consumerのJS / Wasmテストを実行する。
6. 変更をcommitし、annotated tag `v<version>` を作る。GitHubへbranchとtagをpushする。
7. 各モジュールで `moon publish` を実行する。片方が失敗した場合は公開状況を確認し、未公開のモジュールだけを再試行する。同一バージョンの上書きはしない。
8. `moon.work`のない一時consumerからregistry版2モジュールの取得・JS / Wasm実行を確認する。
9. tagを検証してGitHub Releaseを作り、リリースノートと公開ZIP・SHA-256一覧を添付する。公開先とartifactを再取得して確認する。

ZIPは `_build/publish/` に生成される。認証情報、ローカルDB、`node_modules`、MoonBit / Wranglerのcache、通常配信に含めないLSM生成物をrelease assetとして追加しない。

registry版consumerの確認は公開後に実行する。

```sh
moon update
RELEASE_PACK_REGISTRY=1 RELEASE_PACK_TARGETS=js,wasm-gc pnpm exec tsx --test tests/workspace.test.ts
```
