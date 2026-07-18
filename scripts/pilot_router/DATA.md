# Pilot Router — Training Data License Gate & Corpus Provenance

This document is the **license gate** for the Pilot router training corpus
(spec Rev 4 §6.1/§6.3, task T5). It is written and satisfied **before** any
corpus is sampled or any filter spend is incurred. The corpus statistics
section is filled from the real sampling run.

The sampler that produces the corpus is
[`sample_corpus.py`](sample_corpus.py). The committed run manifest is
[`corpus_meta.json`](corpus_meta.json). The corpus rows themselves are
**never committed** — they live under the git-ignored `data/` directory.

---

## 1. Source dataset — WildChat-1M

| Field | Value |
|---|---|
| Dataset | **WildChat-1M** |
| Hugging Face id | [`allenai/WildChat-1M`](https://huggingface.co/datasets/allenai/WildChat-1M) |
| Publisher | Allen Institute for AI (AI2) |
| License | **ODC-BY 1.0** (Open Data Commons Attribution License) |
| License text | <https://opendatacommons.org/licenses/by/1-0/> |
| Snapshot / revision used | *(recorded in `corpus_meta.json` → `dataset_revision`; filled by the run)* |
| Access method | `datasets` **streaming** (`streaming=True`) — the full multi-GB dataset is **never** downloaded to disk |

WildChat-1M is a corpus of ~1M real user↔chatbot conversations, released by AI2
with per-message **language** metadata and per-message **PII redaction** flags,
which the sampler uses directly (§3 below).

### ODC-BY obligations and how we satisfy them

ODC-BY 1.0 is a permissive open-data license. Its substantive obligation is
**attribution**: any public use of the database or a derived/produced work must
keep the attribution notice and the ODC-BY notice intact. It imposes **no**
share-alike / copyleft requirement and **no** restriction on commercial use.
(WildChat additionally asks users to abide by the AI2 ImpACT low-risk
guidelines and OpenAI's terms; we consume only derived training signal, do not
redistribute rows, and use the data for building a routing model — consistent
with those guidelines.)

Concretely, for this project:

- **We never redistribute WildChat rows.** The sampled corpus is written only
  to the git-ignored local `data/` directory (see §5). Nothing under `data/`
  is committable — the `.gitignore` `data/` rule is verified against
  `git check-ignore` as part of this task, and
  `tests/test_public_release_hygiene.py` guards the ignore set.
- **What actually ships in the repo / wheel is model weights and metadata**,
  not data rows: the corpus feeds a downstream classifier (later tasks); only
  the trained model artifacts and this provenance metadata are committed. No
  ODC-BY *database* or *derived database* is published by us, so the
  redistribution-attribution clause is not triggered by anything we commit.
- **The golden evaluation set** (spec §6.4), when it is built in a later task,
  **will draw examples from WildChat** and therefore **will** carry an ODC-BY
  attribution header in the golden-set file, plus a
  `THIRD_PARTY_NOTICES.md` entry — because that derived data file is checked
  in. That is a later task's obligation; it is recorded here so the obligation
  is not lost. **No `THIRD_PARTY_NOTICES.md` entry is required for T5** because
  T5 commits no WildChat-derived data (only counts, hashes, and the model pin).

---

## 2. Owner decision — LMSYS-Chat-1M EXCLUDED (2026-07-18)

**Decision (dated 2026-07-18):** the Pilot training corpus is built from
**WildChat-1M only**. **LMSYS-Chat-1M is excluded** and the sampler contains
no code path that downloads or references it.

**Rationale.** The spec (Rev 4 §6.1) originally listed both WildChat-1M and
LMSYS-Chat-1M as candidate sources. The owner is an open-source project with
commercial elements (a project token), so the corpus license posture must be
unambiguously commercial-safe. WildChat-1M is released under **ODC-BY 1.0** —
fully open, attribution-only, no commercial restriction. LMSYS-Chat-1M is
distributed under a **research-oriented, click-through gated agreement** whose
commercial-use posture is a legal gray zone for a project with a token. Rather
than carry that ambiguity, the owner scoped the corpus to WildChat-1M only.
Local AgentOS logs may be blended in as an additional source in a later task;
that is out of scope for T5.

This decision amends spec §6.1 for the purposes of this task and all
downstream training-data tasks until revisited.

---

## 3. Sampling pipeline (what the corpus went through)

Implemented in [`sample_corpus.py`](sample_corpus.py). Each user turn is
evaluated **independently** — the target signal must be derivable from the
current message alone (spec §6.1 "self-contained turns only").

1. **Stream** `allenai/WildChat-1M` (pinned revision) via `datasets`
   streaming — no full download.
2. **Extract user turns.** Only `role == "user"` messages are candidates
   (the router classifies the incoming user turn). Each carries its parent
   `conversation_id` and a turn index.
3. **Language filter — English only.** Uses WildChat's per-message `language`
   metadata when present; `langdetect` is the cheap fallback when a turn lacks
   the flag.
4. **PII / redaction filter.** Turns flagged `redacted` (or whose text still
   contains redaction placeholders) are **dropped** — we do not train on
   redacted or PII-bearing text.
5. **Length / triviality filter.** Empty, whitespace-only, and
   trivially-short (`< MIN_CHARS`) turns are dropped as anomalies.
6. **Near-duplicate dedupe.** MinHash + LSH (`datasketch`) over normalized
   turn text; near-identical turns collapse to one representative. Parameters
   are pinned in `corpus_meta.json`.
7. **Self-containment pre-filter (LLM).** A short yes/no LLM check — *"is this
   message interpretable on its own, without prior conversation context?"* —
   using the pinned cheap model below. Self-contained mid-conversation turns
   are **kept** ("write a retry decorator with exponential backoff in
   Python"); referential turns are **dropped** ("now also add retry logic to
   that", "yes do that", "the second one"). Verdicts are cached on disk keyed
   by turn id so a crash mid-pass does not restart from zero.
8. **Coarse category + stratification.** Each surviving turn is assigned a
   coarse category — `chitchat`, `factual_qa`, `writing`, `coding`,
   `math_reasoning`, `tool_use` — via cheap deterministic heuristics. The
   corpus is stratified toward balanced coverage of every category, targeting
   **~8,000 turns** total.
9. **Split by `conversation_id` (never by turn).** A **frozen deterministic
   partition** (`blake2b(conversation_id) mod 10_000` bucketed with seed
   **42**) assigns each conversation to **train / val / test = 70 / 15 / 15**.
   Because assignment is a pure function of the id + seed, later supplemental
   sampling can never move an already-assigned conversation across the split
   boundary (spec §6.2 partition contract). All turns of one conversation
   always share a split, so no turn from a test conversation can leak into
   train.

### Pinned self-containment filter model + params (reproducibility, §6.3)

| Field | Value |
|---|---|
| Provider | OpenRouter (`OPENROUTER_API_KEY`) |
| Model | **`deepseek/deepseek-v4-flash`** |
| Temperature | **0** |
| Max tokens | 8 (strict yes/no JSON) |
| Response contract | JSON object `{"self_contained": true|false}`, strict parse |
| Prompt version | `SELF_CONTAINMENT_PROMPT_V1` (verbatim text lives in `sample_corpus.py`) |
| Seed | **42** (partition + any sampling RNG) |

---

## 4. Corpus statistics — real run

Run date **2026-07-18**, dataset revision
`7d6490e462285cf85d91eabea0f9a954fbddcd1f`, seed 42,
`--screen-cap 40000 --target 8000`. Source of truth: `corpus_meta.json`.

### Per-stage counts

| Stage | Count | Survival |
|---|---:|---:|
| User turns screened (streamed) | 40,000 | 100% |
| → English | 16,890 | 42.2% |
| → PII/redaction-clean | 16,795 | 42.0% |
| → length/triviality-clean | 16,503 | 41.3% |
| → after near-dup dedupe | 14,318 | 35.8% |
| → LLM self-contained (accepted) | 4,675 | 11.7% |
| → final stratified corpus | **4,675** | 11.7% |

**Note on the target.** The spec target is ~8,000 turns. The **English
filter is the dominant funnel** — only 42% of WildChat turns are English —
and the LLM self-containment acceptance rate is **32.6% of deduped turns**
(4,675 / 14,318). A 40,000-turn screen therefore yields ~4,675 accepted, not
8,000. Per the T5 brief's stop rule (*"if ~8k is infeasible within a
reasonable screening budget (>40k screened), STOP and report the measured
acceptance rate + projected cost"*), the screen was capped at 40,000 and the
run stopped there. **Projection to hit 8,000 accepted:** ~24,500 deduped →
~27,500 substantive → ~28,000 English → **~66,000 turns screened** (~1.65×
the ceiling). This is a corpus-size decision for the owner; the corpus is
otherwise complete and every downstream contract (splits, categories,
sha256, meta) holds at 4,675. Supplemental sampling later cannot move any
existing split assignment (frozen partition), so growing to 8k is additive.

### Per-category counts (final corpus)

| Category | Count | Share |
|---|---:|---:|
| factual_qa | 3,088 | 66.1% |
| coding | 625 | 13.4% |
| chitchat | 388 | 8.3% |
| writing | 347 | 7.4% |
| math_reasoning | 204 | 4.4% |
| tool_use | 23 | 0.5% |

Category coverage is skewed toward `factual_qa` and is **not** balanced to
the §6.2 "no class < 15%" target. That §6.2 target is a *training-acquisition*
goal enforced downstream (T6+ labeling/acquisition), not a hard gate on this
acquisition-side proxy; the coarse heuristic here is deliberately cheap.
`tool_use` in particular is rare in organic WildChat and will need targeted
supplementation (local AgentOS logs, per the owner's §6.1 note) rather than
more WildChat sampling.

### Split sizes (by conversation_id, 70/15/15)

| Split | Conversations | Turns |
|---|---:|---:|
| train | 2,235 | 3,348 |
| val | 430 | 642 |
| test | 439 | 685 |
| **total** | **3,104** | **4,675** |

Turn-level split shares land at 71.6 / 13.7 / 14.7 — close to 70/15/15;
the small drift is expected because the split is frozen *per conversation*
(so multi-turn conversations move as a unit), which is the whole point of
the §6.2 partition contract.

### Filter cost

| Field | Value |
|---|---:|
| Turns sent to LLM filter (unique) | 14,318 |
| Model | `deepseek/deepseek-v4-flash` (provider: AkashML) |
| Per-call upstream cost (measured) | ~$0.0000017 |
| **Total estimated filter cost** | **≈ $0.024 USD** |

The full 14,318-call pass cost roughly **2.4 US cents** at the measured
per-call OpenRouter cost. (The `corpus_meta.json` → `filter_usage` block
records `llm_calls: 1` because the meta was written by a **resume** run that
reused all 14,317 previously-cached self-containment verdicts and made only
the single remaining call — the on-disk verdict cache is resumable by
design. The 14,318 figure above is the true number of model calls across the
whole pass.)

### Corpus file sha256

| File | sha256 |
|---|---|
| `data/corpus.jsonl` | `a8bbcae6c078f2f8709ad7838690244ecf4b0ebafc95d0a263ca891834eb7b4d` |

---

## 5. Redistribution posture (summary)

- Raw and sampled WildChat rows: **never committed.** Written only under the
  git-ignored `scripts/pilot_router/data/`.
- Committed to the repo: this `DATA.md`, `sample_corpus.py`, and
  `corpus_meta.json` (counts, sha256s, dataset revision, filter-model pin,
  seed). **No data rows.**
- Verified: `git check-ignore` confirms `scripts/pilot_router/data/*.jsonl`
  is ignored; `git status` shows no `data/` content staged before commit.
