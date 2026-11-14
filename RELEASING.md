# Releasing

The package is prepared for npm as `dsh-mise-env` (MIT, version `0.1.0`). Publishing runs in GitHub Actions (`.github/workflows/publish.yml`); publishing from a local checkout is only a fallback.

## One-time setup

1. Confirm the npm name is still free: `npm view dsh-mise-env version` should return 404.
2. Create an npm granular access token that can publish `dsh-mise-env` and bypass 2FA, then store it as the `NPM_TOKEN` repository secret:

   ```sh
   gh secret set NPM_TOKEN -R kele23/dsh-mise
   ```

   The workflow reads the secret through `NODE_AUTH_TOKEN`; it is never printed.

## Publishing a release

1. Run the local checks: `npm test` and `npm pack --dry-run`.
2. Tag the version and push the tag:

   ```sh
   git tag -a v0.1.0 -m "v0.1.0"
   git push origin v0.1.0
   ```

3. Create a GitHub release from tag `v0.1.0` (Releases → Draft a new release). Publishing the release starts the **Publish to npm** workflow, which runs `npm test` and `npm publish --provenance` from the tagged commit. The same workflow can be started manually from the Actions tab.

4. Verify the result:

   ```sh
   npm view dsh-mise-env version
   npm view dsh-mise-env dist.tarball
   ```

## Later releases

1. Bump the version with `npm version patch|minor|major` (or edit `package.json`), keeping `engines.dsh` aligned with the DSH APIs the bundle uses.
2. Push the commit and the generated tag: `git push origin main --follow-tags`.
3. Create a GitHub release from that tag; the workflow performs the npm release.
4. Update the plugin in a DSH profile to pick up the new version.

## Tokenless publishing (after the first release)

npm trusted publishing only works for packages that already exist. After `dsh-mise-env@0.1.0` is on npm, configure the **Publish to npm** workflow as a trusted publisher in npm package settings (npmjs.com → package → Settings → Trusted publishing) and delete the `NPM_TOKEN` secret. Subsequent releases then use the workflow's OIDC token; `--provenance` stays enabled.

## Fallback: manual publish

Only if GitHub Actions is unavailable: `npm login`, then `npm publish --provenance` from a clean checkout of the tag. Provenance is attached only when publishing from CI, so a local publish produces no provenance.

Never commit an npm token; only store it as the `NPM_TOKEN` repository secret.
