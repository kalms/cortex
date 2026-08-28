#!/usr/bin/env node
/**
 * Enforce the merge protocol's release rules mechanically, on the PR, where
 * "CI gate" can block them — instead of relying on the author remembering
 * .claude/rules/workflow.md.
 *
 * This exists because the rules have silently drifted before: 1.1.1–1.2.1 all
 * merged and bumped package.json but were never tagged, and a branch has since
 * been carried at a version *behind* the main it targeted. Prose did not catch
 * either; a required check does.
 *
 * Checks (against the PR's base):
 *   1. Every version field the repo carries agrees with package.json.
 *   2. A release-worthy diff (anything beyond docs/rules) bumps the version.
 *   3. A bumped version is strictly greater than the base's.
 *   4. A bumped version has a CHANGELOG section AND a link reference.
 *
 * Usage:  node scripts/check-release-consistency.mjs [baseRef]
 *         BASE_SHA=<sha> node scripts/check-release-consistency.mjs
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'

const base = process.env.BASE_SHA || process.argv[2] || 'origin/main'
const problems = []
const notes = []

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'))
const readJsonAt = (ref, p) => {
  try {
    return JSON.parse(git('show', `${ref}:${p}`))
  } catch {
    return null // absent at base (new file) — not an error here
  }
}

const parse = (v) => {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v ?? '')
  return m ? m.slice(1, 4).map(Number) : null
}
const cmp = (a, b) => {
  const [x, y] = [parse(a), parse(b)]
  if (!x || !y) return null
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1
  return 0
}

// ── 1. every version field agrees ────────────────────────────────────────────
const version = readJson('package.json').version
notes.push(`package.json version: ${version}`)

// plugin.json is required to match. marketplace.json only carries a version if
// someone re-adds one — if it does, it must agree too (it is a *dev* manifest;
// the published ruevu/plugins catalog deliberately carries no version at all,
// so the plugin's own plugin.json stays the single source of truth there).
const siblings = [
  ['plugin.json', (j) => j?.version, true],
  ['.claude-plugin/marketplace.json', (j) => j?.plugins?.[0]?.version, false],
]
for (const [file, pick, required] of siblings) {
  if (!existsSync(file)) continue
  const v = pick(readJson(file))
  if (v == null) {
    if (required) problems.push(`${file} carries no version field; expected ${version}`)
    else notes.push(`${file}: no version field (fine — resolved from plugin.json)`)
    continue
  }
  if (v !== version) problems.push(`${file} is ${v} but package.json is ${version} — version fields drifted`)
  else notes.push(`${file}: ${v} ✓`)
}

// ── 2/3. bump required, and forward ──────────────────────────────────────────
const basePkg = readJsonAt(base, 'package.json')
const baseVersion = basePkg?.version

if (!baseVersion) {
  notes.push(`base ${base} has no readable package.json — skipping bump checks`)
} else {
  notes.push(`base (${base}) version: ${baseVersion}`)
  // Compare base against the WORKING TREE, not HEAD: identical in CI (where the
  // tree is the pushed commit), but correct locally too — diffing HEAD would
  // silently report "no changes" for uncommitted work and pass vacuously.
  const changed = git('diff', '--name-only', base).split('\n').filter(Boolean)

  // Mirrors the workflow.md docs-only exception: docs/, root *.md, .claude/.
  const isDocs = (f) =>
    f.startsWith('docs/') || f.startsWith('.claude/') || (!f.includes('/') && f.endsWith('.md'))
  const releaseWorthy = changed.filter((f) => !isDocs(f))

  if (version === baseVersion) {
    if (releaseWorthy.length) {
      problems.push(
        `version is unchanged at ${version} but the diff touches non-docs files ` +
          `(${releaseWorthy.slice(0, 5).join(', ')}${releaseWorthy.length > 5 ? ', …' : ''}) — ` +
          `every code merge to main bumps the semver (see .claude/rules/workflow.md)`,
      )
    } else {
      notes.push('docs-only diff at an unchanged version — no bump required ✓')
    }
  } else {
    const order = cmp(baseVersion, version)
    if (order === null) problems.push(`cannot compare versions ${baseVersion} → ${version} (not semver)`)
    else if (order >= 0)
      problems.push(
        `version ${version} is not ahead of base ${baseVersion} — the branch was cut before a ` +
          `release landed on main; rebase and renumber`,
      )
    else notes.push(`bump ${baseVersion} → ${version} ✓`)

    // ── 4. CHANGELOG ─────────────────────────────────────────────────────────
    const log = existsSync('CHANGELOG.md') ? readFileSync('CHANGELOG.md', 'utf8') : ''
    if (!log.includes(`## [${version}]`))
      problems.push(`CHANGELOG.md has no "## [${version}]" section for this release`)
    else notes.push(`CHANGELOG section for ${version} ✓`)
    // Plain line scan, not a regex built from `version`: escaping only dots left
    // every other metacharacter (and backslashes) live in the pattern, which
    // CodeQL correctly flags as incomplete sanitization. Nothing here needs a
    // regex at all.
    const hasLinkRef = log.split('\n').some((line) => line.startsWith(`[${version}]:`))
    if (!hasLinkRef)
      problems.push(`CHANGELOG.md has no "[${version}]: <url>" link reference at the bottom`)
    else notes.push(`CHANGELOG link reference for ${version} ✓`)
  }
}

for (const n of notes) console.log(`  ${n}`)
if (problems.length) {
  console.error('')
  for (const p of problems) console.error(`::error::${p}`)
  console.error(`\nRelease consistency: ${problems.length} problem(s).`)
  process.exit(1)
}
console.log('\nRelease consistency: OK')
