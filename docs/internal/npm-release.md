# npm配布

`npm/sqlike`を`@mizchi/sqlike`、`npm/litestream`を`@mizchi/litestream`として公開する。両方とも初版0.1.0・ESM・MIT。ルートはprivateなデモ / 検証workspaceで、公開しない。Mooncakesの両モジュールも独立したまま維持する。

SQLikeにはJSの実行エンジン、固定DDL / statementのバイナリ実行、独立したNode用compiler、任意のDrizzle entryとWasm GCのassetを含む。compiler・SQLite exporter・Drizzleは別entry。SQLikeのroot / definedにはLitestream、SQLite WASM、Turso、FTS、実験的LSMを読み込まない。機能選択ビルドそのもののツールはリポジトリから使い、生成したruntimeを注入する。

2026-11-16に両packageの0.1.0をnpmへ公開した。registry版を匿名installする外部consumerで、Node、型検査、ChromiumのIndexedDB / offline / 再読込、Wasm GC、Drizzle migration / savepointを確認済み。当時の配布物とregistryのSRIは[0.1.0の検証記録](../../measurements/npm-registry-0.1.0.json)に保存する。初回公開は手元から行ったもので、GitHub OIDCによる公開実績とは区別する。

2026-11-17に両packageの0.1.1をGitHub OIDCで公開した。`v0.1.1`のcommit `31a54cb23b7a5a61065b0d28b271b9a74aa11e91`、[workflowの再実行](https://github.com/mizchi/sqlike/actions/runs/43910506964/attempts/2)が成功し、両packageの`latest`は0.1.1。npmのprovenanceに記録されたworkflow・tag・commitと、subjectのSHA-512、registryのSRI、CIで検査したtarballが一致した。匿名registry consumerでも、新しいcatalog解析・Drizzle preparedを含むNode / 型 / Chromium / Wasm GCの検査を通過した。[0.1.1の検証記録](../../measurements/npm-registry-0.1.1.json)と[リリース全体の記録](../../measurements/release-0.1.1.json)を参照。

初回実行ではnpmがpublishを受理した後に非同期処理を行い、直後のregistry consumer検査が404となった。両versionの反映を確認して同じworkflowを再実行し、既存の公開内容を照合してpublishを省略した上で検査を通した。publish成功直後の404だけを理由に同じversionを再公開したり、tagを移動したりしない。

2026-11-17に両packageの0.1.2をGitHub OIDCで公開した。初回にpublishが受理された後、metadataとtarballが別々に反映され、最初の2回は匿名consumer検査が404となった。両tarballの取得とCI配布物との一致を確認して再実行し、publishを省略して[workflow](https://github.com/mizchi/sqlike/actions/runs/44003805032/attempts/3)は成功し、両packageの`latest`は0.1.2。provenanceのworkflow・tag・source commit、subjectのSHA-512、registryのSRIを照合し、registryのtarballはCI検査済みarchiveと完全一致した。匿名npm consumerと、MooncakesのJS / Wasm GC consumerも通過した。GitHub Releaseの全10 assetを匿名downloadして内容とSHA-256を照合した。[0.1.2のnpm検証記録](../../measurements/npm-registry-0.1.2.json)、[0.1.2のMooncakes検証記録](../../measurements/moon-registry-0.1.2.json)、[リリース全体の記録](../../measurements/release-0.1.2.json)を参照。

2026-11-20（JST）に両packageの0.2.0をGitHub OIDCで公開した。source commitは`e4dcad8860ec60d2d032a966d247c30c0f8125c7`、[公開workflow](https://github.com/mizchi/sqlike/actions/runs/44576013590/attempts/2)は成功。初回で公開を受理した後のregistry反映待ちによる404は、両tarballとprovenanceの取得後に再実行し、既存versionを照合して公開を省略した。CIで検査したtarballとregistry・GitHub Releaseのarchiveは完全一致し、匿名npm / Mooncakes consumer、Vite AOT、3 packageの署名・attestation検証、GitHub Releaseの全10 assetの匿名downloadを確認した。[0.2.0の公開検証](release-0.2.0-verification.md)と[機械可読記録](../../measurements/release-0.2.0.json)を参照。

Litestreamは同期engine / client、policy、HTTP / peer / LTX transport、Session codec、LTX、IndexedDBのreplica storeとNode SQLiteのadapterを公開する。依存は同期のhash用`@noble/hashes`で、DBエンジンの本体は含めない。デモ用notes schemaの初期化は既存engine / clientの動作に含まれる。全driverの全SQLを受理するものではない。

## 作成・検査

```sh
pnpm install --frozen-lockfile
moon update
just npm-check
```

`generated/npm/`に2つのtarballと`audit.json`を作る。OxcでESMを圧縮し、公開export・プロパティ名・purity / license commentを維持する。型定義はTypeScript CLIから生成し、内部のopaque handleのABI宣言を同梱する。

検査はtarballを別ディレクトリへinstallし、workspaceを参照せず実行する。本家sqllogictestの31文・1,000 queryもnative SQLiteと差分比較する。Nodeのnative SQLiteとの差分、binary catalog、SQLite / LTX画像、厳密な型定義、ChromiumのJS / Wasm GC・実IndexedDB・再読込・offline書込を含む。Drizzleは別途installしてmigrationとnested transactionを確認する。配布内容とchunk graphも調べ、任意entryがrootへ混入した場合は落とす。

## 初回公開

```sh
npm login --auth-type=web
npm whoami                          # mizchiを確認
just npm-publish
npm view @mizchi/sqlike@0.1.0 version
npm view @mizchi/litestream@0.1.0 version
```

`npm-publish`は再ビルド・検査後、実際に検査したtarballを`--access public`で公開する。初回はnpmのブラウザ認証 / 2FAが必要となる。認証情報をリポジトリに保存しない。既存の公開バージョンを上書きしない。同じversionがある場合はrepositoryとtarballのintegrityを確認する。npm側の正規化で圧縮tarballが変わった場合は、registryから再取得したtarballのSRI、全ファイル名、各ファイルの内容を照合する。`package.json`の書式だけは許容し、manifestの値やJS / Wasm / 型定義の差異は拒否する。公開後は認証なしのregistry installと同じ外部consumer検査を通す。

staged publishingになった場合は`npm stage list <package>`で確認し、`npm stage view <stage-id>`と`npm stage download <stage-id>`で配布物を検査してから、2FAを伴う`npm stage approve <stage-id>`で公開する。OIDCのpublish権限でstageをapproveすることはできない。既に占有された同じversionへpublishし直さない。

GitHub / Mooncakesの既存`v0.1.0`タグは動かさない。npm向けhost API・package定義は追加commitで管理する。npm registry上の0.1.0は初回配布であり、既存のMooncakesの0.1.0の上書きではない。

## 以後の自動公開

`.github/workflows/npm-release.yml`を使用する。GitHub hosted Ubuntu runner上で、`v*`タグのpushを受けて公開する。repositoryは`mizchi/sqlike`、workflow名は`npm-release.yml`、GitHub Environmentは指定しない。

両packageに、2FAが有効なownerのアカウントで登録する。npm CLI 11.15以上が必要。

```sh
npm trust github @mizchi/sqlike --repo mizchi/sqlike --file npm-release.yml --allow-publish --allow-stage-publish -y
npm trust github @mizchi/litestream --repo mizchi/sqlike --file npm-release.yml --allow-publish --allow-stage-publish -y
npm trust list @mizchi/sqlike
npm trust list @mizchi/litestream
```

`--file`はファイル名のみ。workflowを改名した場合は登録も更新する。CLIが要求する追加認証はnpmの画面で行う。登録済みかどうかは`npm trust list`の実際の結果で確認する。

2026-11-16に両packageの登録と`npm trust list`による照合を完了した。

| package | Trusted Publisher ID |
| --- | --- |
| `@mizchi/sqlike` | `07cd26aa-4359-4fce-9853-77e997f2300d` |
| `@mizchi/litestream` | `83a005a5-2b9c-4595-8480-406fe1a70efc` |

いずれもGitHubの`mizchi/sqlike` / `npm-release.yml`に対して、publishとstage publishを許可する。GitHub上でもworkflowがactiveであることを確認した。OIDC経由の実公開とprovenanceの照合は0.1.1で完了した。

workflowはNode 24、pnpm 10.28.2、npm 11.19.1、MoonBit `0.10.21+06da1ed44`を使い、actionはcommit SHAで固定する。タグ、ルートと両packageのversionを照合し、MoonBit JS / Wasm、独立したnpm consumerのNode / Chromium、型検査を通してから検査済みtarballを公開する。pre-releaseは`next`、通常版は`latest`を使用する。公開後に匿名のregistry consumer検査を実行する。

検査済みのtarballと`audit.json`は、`npm-v<version>-<run_attempt>`のActions artifactへ14日間保存する。GitHub Releaseには公開した回のartifactを使い、registryのSRIと一致するファイルを添付する。ローカルで再ビルドした別のWasm成果物を、CIが公開したtarballと同一だと仮定しない。

`id-token: write`でGitHubのOIDCを使用する。`NPM_TOKEN`や`NODE_AUTH_TOKEN`をsecretから渡さない。公開scriptの`--oidc`は対象repositoryのtag pushとOIDC環境変数を検査し、ローカル公開用の`npm whoami`を省略する。npm自身がOIDCを検証し、Trusted Publishingではprovenanceが自動的に付く。

公開時はversionと変更履歴をcommitし、新しい`v<version>`タグをpushする。既存の`v0.1.0`はworkflow追加前のリリースなので動かさない。ローカル検証が通っても、GitHub上で実行するOIDC公開の成功とは区別する。

`v*`タグの管理者限定rulesetとworkflowのレビュー体制を別途維持する。設定確認:

```sh
gh api repos/mizchi/sqlike/rulesets --jq '.[] | {name, enforcement}'
```

公式手順: [npm trust](https://docs.npmjs.com/cli/v11/commands/npm-trust/)、[Trusted publishing](https://docs.npmjs.com/trusted-publishers/)、[staged publishing](https://docs.npmjs.com/staged-publishing/)。
