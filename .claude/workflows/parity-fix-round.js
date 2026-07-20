// parity-fix-round — standard AgentOS process for burning down migration-parity findings.
//
// Invoke: Workflow({ name: 'parity-fix-round', args: {...} })  (or scriptPath during development)
//
// args contract:
//   worktree   : absolute repo path the round runs in
//   legacyRoot : absolute path of the legacy source (the behavioral contract)
//   matrix     : absolute path of the parity-matrix markdown
//   scopeNote  : scope guard text injected into every agent prompt
//   model      : model for every agent in the round (e.g. 'opus')
//   gates      : { fe: 'shell command', py: 'shell command', legacy: 'shell command that must print empty' }
//   batches    : [{ name, files: [repo-relative files this batch may touch],
//                   items: [{ id, summary, legacyRef, kind: 'code'|'matrix'|'stale-check' }] }]
//
// Process (the standard): batches fix SEQUENTIALLY (same branch — no parallel mutation),
// each batch = one Opus fixer with covering tests + matrix updates + conventional commits;
// then each batch diff gets an adversarial verifier in parallel; real issues go to ONE
// remediation agent; a final gate agent proves everything green and legacy untouched.

export const meta = {
  name: 'parity-fix-round',
  description: 'Standard round: batch-fix parity findings with tests, adversarial re-review, remediation, gates',
  phases: [
    { title: 'Fix', detail: 'sequential batch fixers, one per area' },
    { title: 'Verify', detail: 'adversarial review per batch diff' },
    { title: 'Remediate', detail: 'single remediation pass for confirmed issues' },
    { title: 'Gate', detail: 'FE + Python gates + legacy-untouched proof' },
  ],
}

const cfg = args
if (!cfg || !cfg.worktree || !cfg.batches) throw new Error('parity-fix-round: args contract not satisfied')
const MODEL = cfg.model || undefined

const FIX_SCHEMA = {
  type: 'object',
  required: ['fixed', 'skipped', 'commits'],
  properties: {
    fixed: { type: 'array', items: { type: 'string' } },
    skipped: { type: 'array', items: { type: 'string', description: 'item id + reason (stale/infeasible/needs-owner)' } },
    commits: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
}

const VERIFY_SCHEMA = {
  type: 'object',
  required: ['issues'],
  properties: {
    issues: {
      type: 'array',
      items: {
        type: 'object',
        required: ['file', 'summary', 'severity'],
        properties: {
          file: { type: 'string' },
          summary: { type: 'string' },
          severity: { type: 'string', enum: ['critical', 'important', 'minor'] },
        },
      },
    },
  },
}

phase('Fix')
const fixReports = []
for (const batch of cfg.batches) {
  log(`Fixing batch: ${batch.name} (${batch.items.length} items)`)
  const itemList = batch.items
    .map((it) => `- [${it.id}] (${it.kind}) ${it.summary}${it.legacyRef ? `\n  legacy contract: ${it.legacyRef}` : ''}`)
    .join('\n')
  const report = await agent(
    `You are the batch fixer "${batch.name}" in an AgentOS parity-fix round on ${cfg.worktree} (a git worktree — never cd elsewhere).\n\nItems to resolve, ALL of them:\n${itemList}\n\nRules of the standard process:\n1. The legacy source under ${cfg.legacyRoot} is the behavioral contract — read the cited legacy code BEFORE changing anything; match its behavior exactly unless an item says otherwise.\n2. kind=code: fix the code AND add/extend a covering test (TDD where feasible). kind=matrix: correct the row in ${cfg.matrix} so it tells the truth (docs/superpowers is gitignored — use git add -f). kind=stale-check: verify whether a prior fix already resolved it; if yes record the evidence in the matrix row, if no treat as kind=code.\n3. Touch ONLY files in your batch scope: ${batch.files.join(', ')} (plus their test files and the matrix). NEVER touch anything under ${cfg.legacyRoot} or templates/.\n4. After the batch: run the focused tests for what you changed, then the full FE gate (${cfg.gates.fe}) — it must be fully clean before you commit.\n5. Commit with conventional messages, NO AI attribution trailers. One or few coherent commits for the batch.\n6. An item you cannot fix faithfully gets skipped WITH a reason — never a silent drop, never a fake fix.\n${cfg.scopeNote}`,
    { label: `fix:${batch.name}`, phase: 'Fix', model: MODEL, schema: FIX_SCHEMA },
  )
  fixReports.push({ batch: batch.name, report })
  if (!report) log(`WARNING: batch ${batch.name} returned null (agent lost) — continuing, gate phase will catch breakage`)
}

phase('Verify')
const verifications = await parallel(
  fixReports
    .filter((f) => f.report && f.report.commits.length > 0)
    .map((f) => () =>
      agent(
        `Adversarial post-fix review of batch "${f.batch}" in ${cfg.worktree}. The fixer claims:\nFixed: ${f.report.fixed.join(' | ')}\nSkipped: ${f.report.skipped.join(' | ') || '(none)'}\nCommits: ${f.report.commits.join(', ')}\n\nInspect the commits with git show/git diff (read-only — mutate nothing). For each claimed fix: does the code REALLY match the cited legacy behavior (read the legacy source in ${cfg.legacyRoot} yourself)? Does a test actually assert it (a test that cannot fail is an issue)? Is every skip reason honest? Is the matrix row truthful? Was anything outside the batch scope or under the legacy tree touched? Report ONLY real issues with the fixes; empty array if the batch holds up.\n${cfg.scopeNote}`,
        { label: `verify:${f.batch}`, phase: 'Verify', model: MODEL, schema: VERIFY_SCHEMA },
      ),
    ),
)
const issues = verifications.filter(Boolean).flatMap((v) => v.issues)
const blocking = issues.filter((i) => i.severity !== 'minor')
log(`Verify: ${issues.length} issues (${blocking.length} blocking)`)

let remediation = null
if (blocking.length > 0) {
  phase('Remediate')
  remediation = await agent(
    `Single remediation pass in ${cfg.worktree}. Fix ALL of these confirmed issues with the previous fix batches (same rules as the batch fixers: legacy contract ${cfg.legacyRoot}, covering tests, matrix truthfulness, conventional commits, no attribution, never touch legacy):\n${blocking.map((i) => `- [${i.severity}] ${i.file}: ${i.summary}`).join('\n')}\n\nRun the full FE gate (${cfg.gates.fe}) before committing.`,
    { label: 'remediate', phase: 'Remediate', model: MODEL, schema: FIX_SCHEMA },
  )
}

phase('Gate')
const gate = await agent(
  `Final gate for this parity-fix round in ${cfg.worktree}. Run each and report REAL output:\n1. ${cfg.gates.fe}\n2. ${cfg.gates.py}\n3. ${cfg.gates.legacy}  (must print nothing — legacy byte-identical)\n4. git status --short (must be clean)\n5. git log --oneline over the round's commits.\nDo not fix anything — report failures precisely if any.`,
  {
    label: 'gate',
    phase: 'Gate',
    model: MODEL,
    schema: {
      type: 'object',
      required: ['allGreen', 'summary'],
      properties: {
        allGreen: { type: 'boolean' },
        summary: { type: 'string' },
        commits: { type: 'array', items: { type: 'string' } },
      },
    },
  },
)

return {
  batches: fixReports.map((f) => ({
    batch: f.batch,
    fixed: f.report ? f.report.fixed.length : 0,
    skipped: f.report ? f.report.skipped : ['AGENT LOST'],
    commits: f.report ? f.report.commits : [],
  })),
  verifyIssues: issues,
  remediation,
  gate,
}
