#!/usr/bin/env node
// Checks every plugin in .claude-plugin/marketplace.json at the exact version the marketplace pins,
// then writes what each mod can do to CAPABILITIES.md.
//
//   node scripts/check-mods.mjs           check, and rewrite CAPABILITIES.md
//   node scripts/check-mods.mjs --check   check, and fail if CAPABILITIES.md is out of date (CI)
//
// A plugin fails when:
//   - its source is not pinned (github/url/git-subdir need `sha`, npm needs an exact `version`)
//   - an npm source fails `npm audit signatures`
//   - it ships install scripts or runtime dependencies
//   - it declares MCP or LSP servers, or shell-command hooks (processes outside the Mods API)
//   - `claude plugin validate` fails
//   - code loaded by its mod modules imports anything but `claude-code` and its own files, or
//     reaches for Node/browser globals (process, fetch, require, eval, ...) that would bypass
//     the Mods API. Everything a mod does then goes through `$`, which `claude plugin validate`
//     lists as calls and hooks.
//
// This is a static tripwire, not a sandbox: deliberately obfuscated code can still get past it.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MARKETPLACE = join(ROOT, '.claude-plugin/marketplace.json')
const OUTPUT = join(ROOT, 'CAPABILITIES.md')
const CHECK = process.argv.includes('--check')

// --- what counts as sensitive ---------------------------------------------------------------

// $.<namespace>.* calls that reach outside the mod's own UI and state
const CALL_RISK = {
  process: 'runs local programs',
  fs: 'reads or writes files',
  http: 'makes network requests',
  env: 'reads environment variables',
  settings: 'reads or changes Claude Code settings',
  config: 'reads or changes configuration',
  model: 'calls the model (uses your plan)',
  agent: 'starts agents (uses your plan)',
  mcp: 'drives MCP servers',
  session: 'reads or drives the conversation',
  prompt: 'reads or submits prompts',
  turn: 'steps into model turns',
  tool: 'calls or checks tools',
  telemetry: 'writes telemetry',
  terminal: 'drives the terminal',
  desktop: 'drives the desktop app',
  vscode: 'drives VS Code',
  mobile: 'drives the mobile app',
  plugin: 'manages plugins',
}
const CALL_SAFE = [/^\$\.(ui|state|store|clock|audio)\./, /^\$\.command\.register$/]

// hooks on these events see (and could rewrite) what passes between you, Claude and its tools
const HOOK_RISK = [
  [/^tool\.call$/, 'sees the input and result of every tool call Claude makes, and could rewrite or deny it'],
  [/^tool\./, 'can affect tool checks or descriptions'],
  [/^prompt\./, 'sees or could rewrite what is sent to the model'],
  [/^turn\./, 'sees or could step into model turns'],
  [/^session\.(?!start$)/, 'sees or could rewrite the conversation'],
  [/^agent\./, 'can step into agents'],
  [/^config\./, 'can intercept configuration changes'],
  [/^skill\./, 'can rewrite skill content'],
  [/^attribution\./, 'can rewrite attribution text'],
  [/^telemetry\./, 'sees telemetry events'],
]
const HOOK_SAFE = [/^session\.start$/, /^ui\./, /^command\.run\{command=[^,}]+\}$/, /^command\.describe\{command=[^,}]+\}$/]

// globals that would let a mod act outside the Mods API
const FORBIDDEN_GLOBALS = new Set([
  'require', 'module', 'exports', 'process', 'globalThis', 'global', 'window', 'self', 'navigator',
  'eval', 'Function', 'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'Worker', 'SharedWorker',
  'WebAssembly', 'Bun', 'Deno', '__dirname', '__filename', 'importScripts',
])
const FORBIDDEN_PROPS = new Set(['constructor', '__proto__', '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__'])
const ALLOWED_PACKAGES = new Set(['claude-code'])
const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare']

// --- fetching the pinned source -------------------------------------------------------------

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts })

function fetchGit(url, sha, work) {
  const dir = join(work, 'src')
  run('git', ['init', '-q', dir])
  run('git', ['-C', dir, 'fetch', '-q', '--depth', '1', url, sha])
  run('git', ['-C', dir, 'checkout', '-q', 'FETCH_HEAD'])
  const head = run('git', ['-C', dir, 'rev-parse', 'HEAD']).trim()
  if (head !== sha) throw new Error(`checked out ${head}, expected ${sha}`)
  return dir
}

async function fetchNpm(pkg, version, work, info) {
  writeFileSync(join(work, 'package.json'), '{"private":true}\n')
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', `${pkg}@${version}`], { cwd: work })
  // verifies the registry signature, and the provenance attestation when there is one
  const audit = run('npm', ['audit', 'signatures'], { cwd: work })
  info.provenance = /verified attestation/.test(audit) ? await provenanceOf(pkg, version) : null
  const dir = join(work, 'node_modules', pkg)
  const installed = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version
  if (installed !== version) throw new Error(`installed ${installed}, expected ${version}`)
  return dir
}

// the repo and commit the npm provenance attestation says the tarball was built from
async function provenanceOf(pkg, version) {
  const meta = JSON.parse(run('npm', ['view', `${pkg}@${version}`, 'dist.attestations', '--json']))
  const res = await fetch(meta.url)
  if (!res.ok) throw new Error(`attestations: HTTP ${res.status}`)
  const { attestations } = await res.json()
  const slsa = attestations.find(a => a.predicateType.startsWith('https://slsa.dev/provenance/'))
  const statement = JSON.parse(Buffer.from(slsa.bundle.dsseEnvelope.payload, 'base64').toString('utf8'))
  const dep = statement.predicate.buildDefinition.resolvedDependencies[0]
  return { uri: dep.uri.replace(/^git\+/, ''), commit: dep.digest.gitCommit }
}

async function fetchSource(source, work, info) {
  const sha = source.sha
  const needSha = () => {
    if (!/^[0-9a-f]{40}$/.test(sha ?? '')) throw new Error(`${source.source} source must pin a full 40-character "sha"`)
  }
  switch (source.source) {
    case 'github':
      needSha()
      info.pin = `github \`${source.repo}\` @ \`${sha}\``
      return fetchGit(`https://github.com/${source.repo}.git`, sha, work)
    case 'url':
      needSha()
      info.pin = `git \`${source.url}\` @ \`${sha}\``
      return fetchGit(source.url, sha, work)
    case 'git-subdir':
      needSha()
      info.pin = `git \`${source.url}\` \`${source.path}\` @ \`${sha}\``
      return join(fetchGit(source.url, sha, work), source.path)
    case 'npm':
      if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(source.version ?? '')) throw new Error('npm source must pin an exact "version"')
      if (source.registry) throw new Error('npm source with a custom registry is not supported')
      info.pin = `npm \`${source.package}@${source.version}\``
      return fetchNpm(source.package, source.version, work, info)
    default:
      throw new Error(`source "${source.source}" can't be pinned and checked`)
  }
}

// --- plugin-level checks --------------------------------------------------------------------

const readJson = p => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null)

function checkPackage(dir, fail) {
  const pkg = readJson(join(dir, 'package.json'))
  if (!pkg) return
  for (const s of INSTALL_SCRIPTS) if (pkg.scripts?.[s]) fail(`package.json has an install script "${s}"`)
  for (const k of ['dependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies', 'bundledDependencies']) {
    const deps = pkg[k]
    if (deps && (Array.isArray(deps) ? deps.length : Object.keys(deps).length)) fail(`package.json has ${k}`)
  }
}

// mod entry modules, plus anything that runs outside the Mods API
function components(dir, fail) {
  const manifest = readJson(join(dir, '.claude-plugin/plugin.json')) ?? {}
  if (manifest.mcpServers || existsSync(join(dir, '.mcp.json'))) fail('declares MCP servers')
  if (manifest.lspServers || existsSync(join(dir, '.lsp.json'))) fail('declares LSP servers')

  const hookFiles = []
  const add = (h, base) => {
    if (typeof h === 'string') hookFiles.push(resolve(base, h))
    else if (Array.isArray(h)) h.forEach(x => add(x, base))
    else if (h && typeof h === 'object') hookFiles.push({ inline: h, base })
  }
  if (existsSync(join(dir, 'hooks/hooks.json'))) add('hooks/hooks.json', dir)
  if (manifest.hooks) add(manifest.hooks, dir)

  const modules = new Set()
  for (const f of hookFiles) {
    const { json, base } = typeof f === 'string' ? { json: readJson(f), base: dirname(f) } : { json: f.inline, base: f.base }
    if (json?.hooks && Object.keys(json.hooks).length) fail('declares shell-command hooks')
    for (const m of json?.modules ?? []) modules.add(resolve(base, m))
  }

  const extras = []
  for (const k of ['commands', 'agents', 'skills', 'outputStyles']) {
    if (manifest[k] || existsSync(join(dir, k))) extras.push(k)
  }
  return { modules: [...modules], extras }
}

// what `claude plugin validate` reports each module hooks and calls
function validate(dir, fail) {
  let out
  try {
    out = run('claude', ['plugin', 'validate', dir])
  } catch (e) {
    fail(`claude plugin validate failed:\n${e.stdout}${e.stderr}`)
    return { hooks: [], calls: [] }
  }
  const hooks = new Set()
  const calls = new Set()
  for (const line of out.split('\n')) {
    const m = /❯ \S+ (hooks|calls): (.*)$/.exec(line)
    if (!m) continue
    for (const item of splitTop(m[2])) (m[1] === 'hooks' ? hooks : calls).add(item.replace(/ \(via [^)]*\)$/, ''))
  }
  return { hooks: [...hooks].sort(), calls: [...calls].sort() }
}

// split "a, b{x=1, y=2}, c" on the commas outside braces
function splitTop(s) {
  const parts = []
  let depth = 0
  let cur = ''
  for (const ch of s) {
    if (ch === '{') depth++
    if (ch === '}') depth--
    if (ch === ',' && depth === 0) {
      parts.push(cur.trim())
      cur = ''
    } else cur += ch
  }
  if (cur.trim()) parts.push(cur.trim())
  return parts
}

// --- static guard over the code the mod loads -----------------------------------------------

const CODE_EXT = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']
const isDecl = f => /\.d\.[cm]?ts$/.test(f)
const isFile = f => existsSync(f) && statSync(f).isFile()

function resolveImport(from, spec) {
  const base = resolve(dirname(from), spec)
  const swapped = base.replace(/\.([cm]?)js$/, '.$1ts')
  const candidates = [base, swapped, ...CODE_EXT.map(e => base + e), ...CODE_EXT.map(e => join(base, 'index' + e)), base + '.json']
  return candidates.find(c => isFile(c) && !isDecl(c)) ?? candidates.find(isFile)
}

function scriptKind(f) {
  if (f.endsWith('.tsx')) return ts.ScriptKind.TSX
  if (f.endsWith('.jsx')) return ts.ScriptKind.JSX
  if (/\.[cm]?js$/.test(f)) return ts.ScriptKind.JS
  return ts.ScriptKind.TS
}

// identifiers that name something rather than reference a global
function isNameOnly(id) {
  const p = id.parent
  if ((ts.isPropertyAccessExpression(p) || ts.isQualifiedName(p)) && p.name === id) return true
  if ((ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p) || ts.isPropertyDeclaration(p) || ts.isGetAccessor(p)
    || ts.isSetAccessor(p) || ts.isPropertySignature(p) || ts.isMethodSignature(p) || ts.isEnumMember(p)) && p.name === id) return true
  if (ts.isBindingElement(p) && p.propertyName === id) return true
  if ((ts.isImportSpecifier(p) || ts.isExportSpecifier(p)) && (p.propertyName === id || p.name === id)) return true
  if (ts.isJsxAttribute(p) && p.name === id) return true
  if ((ts.isLabeledStatement(p) || ts.isBreakOrContinueStatement(p)) && p.label === id) return true
  return false
}

function guard(entries, pluginDir) {
  const problems = []
  const seen = new Set()
  const queue = [...entries]
  const at = (sf, node) => `${relative(pluginDir, sf.fileName)}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`

  while (queue.length) {
    const file = queue.shift()
    if (seen.has(file)) continue
    seen.add(file)
    if (!isFile(file)) {
      problems.push(`${relative(pluginDir, file)}: module not found`)
      continue
    }
    if (isDecl(file) || file.endsWith('.json')) continue
    const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, scriptKind(file))

    const follow = (node, spec, typeOnly) => {
      if (typeOnly) return
      if (spec.startsWith('./') || spec.startsWith('../')) {
        const target = resolveImport(file, spec)
        if (!target) return problems.push(`${at(sf, node)}: can't resolve "${spec}"`)
        if (relative(pluginDir, target).startsWith('..' + sep)) return problems.push(`${at(sf, node)}: imports outside the plugin "${spec}"`)
        queue.push(target)
      } else if (!ALLOWED_PACKAGES.has(spec)) {
        problems.push(`${at(sf, node)}: imports "${spec}"`)
      }
    }

    const visit = node => {
      // types are erased at runtime
      if (ts.isTypeNode(node) && !ts.isExpressionWithTypeArguments(node)) return
      if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return

      if (ts.isImportDeclaration(node)) {
        follow(node, node.moduleSpecifier.text, node.importClause?.isTypeOnly)
        return
      }
      if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
        follow(node, node.moduleSpecifier.text, node.isTypeOnly)
        return
      }
      if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
        problems.push(`${at(sf, node)}: import = require()`)
      } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        problems.push(`${at(sf, node)}: dynamic import()`)
      } else if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) {
        problems.push(`${at(sf, node)}: import.meta`)
      } else if (ts.isIdentifier(node) && FORBIDDEN_GLOBALS.has(node.text) && !isNameOnly(node)) {
        problems.push(`${at(sf, node)}: uses "${node.text}"`)
      } else if (ts.isPropertyAccessExpression(node) && FORBIDDEN_PROPS.has(node.name.text)) {
        problems.push(`${at(sf, node)}: accesses ".${node.name.text}"`)
      } else if (ts.isElementAccessExpression(node)) {
        const arg = node.argumentExpression
        if (ts.isStringLiteralLike(arg) && FORBIDDEN_PROPS.has(arg.text)) {
          problems.push(`${at(sf, node)}: accesses ["${arg.text}"]`)
        } else if (ts.isIdentifier(node.expression) && node.expression.text === '$' && !ts.isStringLiteralLike(arg)) {
          // would hide Mods API calls from `claude plugin validate`
          problems.push(`${at(sf, node)}: computed access on $`)
        }
      } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
        && ['setTimeout', 'setInterval'].includes(node.expression.text)
        && node.arguments[0] && (ts.isStringLiteralLike(node.arguments[0]) || ts.isTemplateExpression(node.arguments[0]))) {
        problems.push(`${at(sf, node)}: ${node.expression.text} with a string`)
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }
  const files = [...seen].filter(f => isFile(f) && !isDecl(f) && !f.endsWith('.json')).map(f => relative(pluginDir, f)).sort()
  return { problems, files }
}

// --- report ---------------------------------------------------------------------------------

function callLabel(call) {
  if (CALL_SAFE.some(r => r.test(call))) return null
  const ns = /^\$\.([a-zA-Z]+)\./.exec(call)?.[1]
  return CALL_RISK[ns] ?? 'unclassified, needs review'
}

function hookLabel(hook) {
  if (HOOK_SAFE.some(r => r.test(hook))) return null
  const event = hook.replace(/\{.*$/, '')
  return HOOK_RISK.find(([r]) => r.test(event))?.[1] ?? 'unclassified, needs review'
}

function section(p) {
  const lines = [`## ${p.name}`, '']
  lines.push(`- Source: ${p.pin}`)
  if (p.provenance !== undefined) {
    lines.push(p.provenance
      ? `- npm provenance: verified, built from \`${p.provenance.uri}\` @ \`${p.provenance.commit}\``
      : '- npm provenance: none (registry signature verified only)')
  }
  lines.push(`- Code loaded: ${p.files.map(f => `\`${f}\``).join(', ') || 'none'}`)
  lines.push(`- Other components: ${p.extras.length ? p.extras.join(', ') : 'none'}`)
  lines.push('')
  const table = (title, items, label) => {
    lines.push(`### ${title}`, '')
    if (!items.length) return lines.push('None', '')
    lines.push('| Item | What it means |', '|---|---|')
    for (const it of items) {
      const l = label(it)
      lines.push(l ? `| \`${it}\` | **${l}** |` : `| \`${it}\` | ordinary |`)
    }
    lines.push('')
  }
  table('Hooks', p.hooks, hookLabel)
  table('Mods API calls', p.calls, callLabel)
  return lines.join('\n')
}

function render(plugins) {
  return [
    '# Mod capabilities',
    '',
    "Generated by `scripts/check-mods.mjs` from the versions pinned in `.claude-plugin/marketplace.json`; don't edit it by hand. CI regenerates it on every run and fails if it differs, so any change in what a mod can do shows up in the pull request's diff.",
    '',
    'The code each mod loads passes a static check: it imports only `claude-code` and its own files, and uses no Node or browser globals such as `process`, `fetch`, `require` or `eval`. So everything it can do goes through the Mods API and is listed below. Items in bold touch your files, programs, network, settings, conversation or usage.',
    '',
    ...plugins.map(section),
  ].join('\n')
}

// --- main -----------------------------------------------------------------------------------

const marketplace = JSON.parse(readFileSync(MARKETPLACE, 'utf8'))
const results = []
let failed = false

for (const entry of marketplace.plugins) {
  const info = { name: entry.name }
  let ok = true
  const fail = msg => {
    failed = true
    ok = false
    console.error(`✘ ${entry.name}: ${msg}`)
  }
  const work = mkdtempSync(join(tmpdir(), `check-${entry.name}-`))
  try {
    if (typeof entry.source !== 'object') throw new Error('relative-path sources are not supported')
    const dir = await fetchSource(entry.source, work, info)
    checkPackage(dir, fail)
    const { modules, extras } = components(dir, fail)
    if (!modules.length) fail('has no mod modules')
    const { hooks, calls } = validate(dir, fail)
    const { problems, files } = guard(modules, dir)
    problems.forEach(fail)
    results.push({ ...info, extras, hooks, calls, files })
    if (ok) console.log(`✔ ${entry.name}: ${info.pin}, ${files.length} files, ${hooks.length} hooks, ${calls.length} calls`)
  } catch (e) {
    fail(e.stderr ? `${e.message}\n${e.stderr}` : e.message)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

const report = render(results) + '\n'
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report)

if (failed) {
  process.exitCode = 1
} else if (CHECK) {
  const current = existsSync(OUTPUT) ? readFileSync(OUTPUT, 'utf8') : ''
  if (current !== report) {
    console.error('✘ CAPABILITIES.md is out of date: run `npm run check-mods` and commit the result')
    process.exitCode = 1
  }
} else {
  writeFileSync(OUTPUT, report)
  console.log('wrote CAPABILITIES.md')
}
