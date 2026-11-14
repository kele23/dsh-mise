#!/usr/bin/env node
/**
 * Release checks for dsh-mise-env: syntax, manifest, locales, patch, icon, and
 * the files an npm tarball is expected to carry. Run by `npm test` and
 * `prepublishOnly`; it has no dependencies.
 */
import { execFileSync } from 'node:child_process'
import { readFile, readdir, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

let failed = false

function fail(message) {
  failed = true
  console.error(`check: ${message}`)
}

async function readJson(relativePath) {
  return JSON.parse(await readFile(new URL(relativePath, import.meta.url), 'utf8'))
}

async function exists(relativePath) {
  try {
    await stat(new URL(relativePath, import.meta.url))
    return true
  } catch {
    return false
  }
}

execFileSync(process.execPath, ['--check', fileURLToPath(new URL('../index.js', import.meta.url))], { stdio: 'inherit' })

const pkg = await readJson('../package.json')
for (const field of ['name', 'version', 'description', 'license', 'homepage']) {
  if (typeof pkg[field] !== 'string' || pkg[field].length === 0) fail(`package.json is missing "${field}"`)
}
const repository = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url
if (typeof repository !== 'string' || !repository.includes('github.com/kele23/dsh-mise')) fail('package.json repository must point at kele23/dsh-mise')
if (pkg.name !== 'dsh-mise-env') fail(`unexpected package name "${pkg.name}"`)
if (pkg.version !== '0.1.0') fail(`unexpected version "${pkg.version}"`)
if (pkg.license !== 'MIT') fail('package.license must be MIT')
if (pkg.private === true) fail('package.private must be removed for an npm release')
if (pkg.dsh?.bundle?.patch !== './cordis.patch.yml') fail('dsh.bundle.patch must be ./cordis.patch.yml')
if (!pkg.engines || typeof pkg.engines.dsh !== 'string') fail('engines.dsh is required')

const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
if (!patch.includes(`name: ${pkg.name}`)) fail('cordis.patch.yml does not insert the package name')

for (const locale of ['en', 'it']) {
  const meta = (await readJson(`../locale/${locale}.json`)).meta
  if (typeof meta?.title !== 'string' || meta.title.length === 0) fail(`locale/${locale}.json has no meta.title`)
  if (typeof meta?.description !== 'string' || meta.description.length === 0) fail(`locale/${locale}.json has no meta.description`)
}

const iconPath = new URL('../icon.svg', import.meta.url)
const icon = await readFile(iconPath, 'utf8')
if (!/<svg[\s>]/.test(icon)) fail('icon.svg is not an SVG document')
if (/<(script|style|foreignObject|image)\b/i.test(icon)) fail('icon.svg contains a disallowed element')
if ((await stat(iconPath)).size > 256 * 1024) fail('icon.svg exceeds 256 KiB')

for (const file of ['index.js', 'cordis.patch.yml', 'README.md', 'LICENSE', 'icon.svg']) {
  if (!(await exists(`../${file}`))) fail(`missing ${file}`)
}
if (!(await exists('../locale/en.json')) || !(await exists('../locale/it.json'))) fail('missing locale files')

const packedLocales = (await readdir(new URL('../locale', import.meta.url))).filter(file => file.endsWith('.json'))
if (packedLocales.length < 2) fail('expected English and Italian locale files')

if (failed) process.exit(1)
console.log(`check: ok (${pkg.name}@${pkg.version}, ${packedLocales.length} locales)`)
