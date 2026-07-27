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
