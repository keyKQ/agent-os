# Curated memory baseline — 2026-07-27

Reference numbers for the memory system as it stands, so a rebuild has
something to be measured against. Reproduce with:

```bash
uv run python scripts/memory_bench.py --trials 5 --isolate-curated
uv run python scripts/memory_bench.py --trials 5 --isolate-curated \
    --facts tests/data/memory_bench/facts_incidental.jsonl
```

Conditions: `z-ai/glm-5.2` via OpenRouter, 5 trials per corpus,
`--isolate-curated` (turn capture off, so the curated block is the only path
a planted fact can travel), commit `bdacd6d`.

## Results

| | explicit | incidental |
| --- | --- | --- |
| capture — reached MEMORY.md/USER.md | 92% | 100% |
| recall — fresh session, no tools | 84% | 95% |
| entries written per trial | 3.6 | 3.6 |
| noise entries per trial | 0.2 | 0.6 |
| nudge reviews fired | 0 | 0 |
| trials that wrote nothing | 0 | 0 |

Per-fact, explicit corpus: `role` 100/100, `brevity` 80/60, `timezone` 80/100,
`testing` 100/80, `deploy` 100/80 (capture/recall).

Per-fact, incidental corpus: `stack` 100/100, `brevity` 100/100,
`envname` 100/80, `ci` 100/100.

## Reading these numbers honestly

**Recall is understated.** Three of the misses were infrastructure, not
memory: one 120s turn timeout and two OpenRouter `HTTP 404` responses from the
provider's own routing. Scored as misses because the harness cannot tell a
blank answer from a wrong one.

**The explicit corpus's 0.2 noise is a matcher artifact, not noise.** The agent
split the `deploy` fact into two entries ("Deploy cadence: Fridays only." /
"Owns the release checklist."). The matcher wants both halves in one entry, so
each half scored as unclaimed. Splitting a two-part fact is arguably correct
behaviour.

**The incidental corpus's 0.6 noise is real, and it is the most interesting
result here.** In 3 of 5 trials the agent wrote a user-profile entry the user
never stated — a `Timezone:` line naming the *host machine's* zone, in a corpus
that never mentions a timezone at all.

The source is `_runtime_context_block` (`src/agentos/engine/agent.py:3795`),
which injects `Time zone / location hint: <host tz>` into every turn and tells
the model "Do not treat it as a user request". `_append_runtime_context_to_user_message`
(`agent.py:3850`) then concatenates that block into the user's own message, and
three prompt surfaces name timezone as a canonical USER.md field
(`system_prompt.j2:128`, `:150`, `memory_tools.py:812`). The model is doing what
it was told. So the failure mode on display is **precision — fabricated profile
data — not retention.**

This is also why the `timezone` fact in `facts.jsonl` plants `UTC` rather than a
regional zone: the planted value must differ from whatever the host reports, or
a fabricated entry would score as a genuine capture.

**The nudge never fired, in any of the 10 trials.** Not a harness fault:
`_note_turn_for_memory_nudge` (`runtime.py:1910`) resets the counter to zero
whenever the turn already used the `memory` tool, and this agent saves
unprompted on nearly every turn. The review path is effectively dormant while
the model is diligent, which means it is largely untested in practice.

## After the fixes

Same conditions, same corpora, same matcher, re-run against the three
changes that followed from the numbers above.

| | explicit | incidental |
| --- | --- | --- |
| capture | 92% → **96%** | 100% → **100%** |
| recall | 84% → **92%** | 95% → **95%** |
| noise per trial | 0.2 → **0.2** | 0.6 → **0.0** |
| nudge reviews | 0 → **7** | 0 → **0** |

**Fabrication is gone.** The incidental corpus wrote no invented profile
entry in any trial, down from 3 of 5. Capture and recall held.

**The review runs.** Seven reviews across five explicit trials, up from zero,
each reporting what it wrote via `memory_nudge.review_done`.

Two things this table does not show, both worth knowing:

The incidental corpus still reports zero reviews, and that is the honest limit
of the change rather than a measurement artifact. A self-directed write now
holds the counter instead of clearing it, so a review is delayed rather than
cancelled — but every turn in that corpus carries save-worthy content, so the
agent saves on all of them and the counter never advances. An agent that saves
on literally every turn still never gets a consolidation pass. Bounding the
hold (force a review after, say, `2 × interval` held turns) would close it.

The explicit corpus's residual 0.2 noise is the same matcher artifact called
out above: the agent wrote `Deployments happen on Fridays only; owns the
release checklist.`, which is correct, but the ownership matcher does not list
`owns`.

## What this does not cover

The numbers contradict the impression that memory "works poorly", so the felt
failure is probably somewhere these corpora do not reach:

- long sessions, where the injection budget and consolidation start evicting
- accumulation across many sessions rather than one
- multi-agent workspaces
- models weaker than glm-5.2 at following the save instruction

Worth narrowing before rebuilding, otherwise the rebuild targets the wrong
thing.

## Known limitation

Matching is substring-based, so a few matchers are loose: `go` also matches
"going"/"Django", and `no ` matches almost any sentence. Word-boundary
matching would tighten `role`, `testing`, and `brevity`. The rates above are
therefore a mild over-estimate, and the same matcher must be used on both
sides of any before/after comparison.
