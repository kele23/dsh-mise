# Releasing

`dsh-mise-env` is published with **npm trusted publishing (OIDC)**: the workflow uses a short-lived GitHub OIDC token, not a stored `NPM_TOKEN`. The one exception is the unavoidable first publish described below.

## One-time bootstrap

npm cannot create a trusted publisher for a package that does not exist yet, so the first version must be placed on the registry once with an interactive npm login and 2FA. No npm token is committed or stored in GitHub. Choose one:

- **Recommended — keep `0.1.0` on the OIDC path:** publish a throwaway `0.0.0` stub once, configure the trusted publisher, then let the workflow publish `0.1.0` with provenance.
- **Simpler — publish `0.1.0` once manually:** then every later version uses the OIDC workflow. The manual `0.1.0` has no provenance.

### 1. Log in

```sh
npm login
```

This is an interactive browser/2FA login; do not create a long-lived token for GitHub.

### 2a. Stub path (keeps `0.1.0` on OIDC)

Publish a minimal placeholder package once:

```sh
tmp=$(mktemp -d)
cat > "$tmp/package.json" <<'EOF'
{
  "name": "dsh-mise-env",
  "version": "0.0.0",
  "description": "Trusted-publishing bootstrap placeholder",
  "license": "MIT"
}
EOF
(cd "$tmp" && npm publish --access public)
```

### 2b. Manual path

Publish the real version once from tag `v0.1.0`:

```sh
git checkout v0.1.0
npm publish --access public
```

With this path the workflow cannot publish `0.1.0` again; the next release must be a later version.

### 3. Configure the trusted publisher

```sh
npm trust github dsh-mise-env \
  --file publish.yml \
  --repo kele23/dsh-mise \
  --allow-publish \
  --yes
```

The same configuration can be created at npmjs.com → `dsh-mise-env` → Settings → Trusted Publisher → GitHub Actions with organization `kele23`, repository `dsh-mise`, workflow file `publish.yml`, and **Allow npm publish** enabled.

Check it with:

```sh
npm trust list dsh-mise-env
```

`npm trust` requires npm CLI 11.19 or later. npm expires a new trusted publisher connection unless its first successful OIDC publish happens within 2 days, so create the connection only when you are ready to cut the release.

### 4. Publish `0.1.0` (stub path only)

Create a GitHub release from tag `v0.1.0`. The **Publish to npm** workflow runs `npm test` and `npm publish --provenance` using OIDC. If the trusted publisher was created with the stub path, this is the first real release and it carries provenance.

## Later releases

1. Bump the version with `npm version patch|minor|major` (or edit `package.json`), keeping `engines.dsh` aligned with the DSH APIs the bundle uses.
2. Push the commit and tag: `git push origin main --follow-tags`.
3. Create a GitHub release from that tag; the workflow publishes it via OIDC with provenance.
4. Update the plugin in a DSH profile to pick up the new version.

## Security notes

- No `NPM_TOKEN` or other long-lived npm credential is stored in the repository.
- The trusted publisher configuration is bound to this repository and to the exact workflow filename `publish.yml`.
- Keep `permissions: id-token: write` in the workflow; without it npm cannot exchange the OIDC token.
- Optionally enable “disallow tokens” for the package after OIDC is verified, so future publishing can only come from the trusted workflow.
