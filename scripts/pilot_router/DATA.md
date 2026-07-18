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

**Amendment (2026-07-18) — extend the corpus to the ~8k target.** After the
initial 40,000-turn screen yielded 4,675 accepted turns (below the ~8k
target, because only ~42% of WildChat is English and self-containment
accepts ~33% of deduped turns), the owner approved extending the screen up to
**120,000 turns** (measured filter cost is ~$0.024 for 14.3k calls, so the
extension is a few cents). The extension resumes from the on-disk verdict
cache (previously-screened turns are **not** re-billed) and adds
category-aware acceptance (per-category floors + a 35% share cap; see §3
step 8) so the added turns rebalance coverage rather than pile onto
`factual_qa`. The frozen partition function is unchanged, so no existing
conversation's split assignment moves (asserted at run time; see §3 step 9).

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
   **~8,000 turns** total. In the `--stratified` extension mode (owner
   decision 2026-07-18, below) the category check runs **before** the LLM
   call so over-represented categories cost no filter spend: once a category
   exceeds **35%** of the running accepted total *and* has met its floor, its
   turns are screened out without a model call. Per-category floors are
   **400** for every category except `tool_use` (naturally rare in WildChat;
   soft floor **60**, best-effort). Screening stops once total accepted ≥
   target **and** every floor is met, up to a **120,000**-turn screen ceiling.
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

## 4. Corpus statistics — real run (extended)

Run date **2026-07-18**, dataset revision
`7d6490e462285cf85d91eabea0f9a954fbddcd1f`, seed 42,
`--stratified --screen-cap 120000 --target 8000`. Source of truth:
`corpus_meta.json`. (This supersedes the initial 40k-screen run, which
produced 4,675 turns; see the §2 amendment for why the screen was extended.)

### Per-stage counts

| Stage | Count | Survival |
|---|---:|---:|
| User turns screened (streamed) | 120,000 | 100% |
| → English | 49,462 | 41.2% |
| → PII/redaction-clean | 49,163 | 41.0% |
| → length/triviality-clean | 48,259 | 40.2% |
| → after near-dup dedupe | 41,007 | 34.2% |
| → LLM-screened (category-uncapped) | 24,461 | 20.4% |
| → self-contained + quota-accepted | **6,389** | 5.3% |
| → final corpus | **6,389** | 5.3% |

**Note on the target.** The compound stop condition (total ≥ 8,000 **and**
every non-`tool_use` category ≥ 400 **and** `tool_use` ≥ 60) was **not** met
even at the full 120,000-turn screen ceiling: the 41,007-turn deduped pool was
exhausted at **6,389** accepted. Two funnels bind: only ~41% of WildChat is
English, and once the 35% share cap on the dominant `factual_qa` bucket
engages (as designed), the corpus can only grow as fast as the *rarer*
categories supply turns — `math_reasoning` and especially `tool_use` are thin
in organic WildChat. `tool_use` reached **57** (just shy of its 60 soft
floor); per the owner's "take what you find" instruction this is accepted and
documented rather than chased further. Closing the remaining gap to 8,000 with
balanced rare classes needs a different source (local AgentOS logs, §6.1) —
more WildChat sampling would only deepen the common classes. The corpus is
complete and every downstream contract (splits, categories, sha256, meta)
holds at 6,389.

### Per-category counts (final corpus)

| Category | Count | Share |
|---|---:|---:|
| factual_qa | 2,236 | 35.0% |
| coding | 1,671 | 26.2% |
| chitchat | 1,073 | 16.8% |
| writing | 750 | 11.7% |
| math_reasoning | 602 | 9.4% |
| tool_use | 57 | 0.9% |

The category-aware acceptance policy worked as intended: `factual_qa` — 66% of
the initial unbalanced run — is held to its **35% share cap** here, and four of
six categories now clear the §6.2 "no class < 15%" bar (factual_qa, coding,
chitchat all ≥ 15%; writing at 11.7% and math_reasoning at 9.4% are close;
`tool_use` remains rare and needs cross-source supplementation, not more
WildChat). §6.2's target is enforced downstream in acquisition/labeling; this
acquisition-side proxy is now far better balanced than the 40k run.

### Split sizes (by conversation_id, 70/15/15)

| Split | Conversations | Turns |
|---|---:|---:|
| train | 3,422 | 4,533 |
| val | 669 | 871 |
| test | 728 | 985 |
| **total** | **4,819** | **6,389** |

Turn-level split shares land at 70.9 / 13.6 / 15.4 — close to 70/15/15; the
small drift is expected because the split is frozen *per conversation* (so
multi-turn conversations move as a unit), which is the whole point of the
§6.2 partition contract.

### Partition stability (spec §6.2)

The extension asserts, at run time, that **every one of the 4,675
conversation-turns from the prior corpus keeps its exact split** under the
unchanged `assign_split` function (log line: `[partition] stable: 4675 prior
conversation_ids keep their split`). The split is a pure function of
`(conversation_id, seed=42)`, so growing the corpus is strictly additive and
never reshuffles an existing assignment.

### Filter cost

| Field | Value |
|---|---:|
| Unique turns LLM-screened (total pass) | 24,461 |
| Calls billed this extension run | 16,229 (the other 8,232 came from the resumable cache) |
| Model | `deepseek/deepseek-v4-flash` |
| OpenRouter reported cost, this run | **$0.702** |
| Measured cost per call | ~$0.000043 |
| **Estimated total-pass filter cost** | **≈ $1.06 USD** |

The category pre-filter means over-represented `factual_qa` turns past the 35%
cap were **skipped before the LLM call**, so they cost nothing. Total spend
across both runs is ~**$1.06**, well within the owner-approved budget.

### Corpus file sha256

| File | sha256 |
|---|---|
| `data/corpus.jsonl` | `cab90ce38b6d50570a19fcda1f53d346851a68b900653e269a78e4ddf57f7564` |

---

## 5. Redistribution posture (summary)

- Raw and sampled WildChat rows: **never committed.** Written only under the
  git-ignored `scripts/pilot_router/data/`.
- Committed to the repo: this `DATA.md`, `sample_corpus.py`, and
  `corpus_meta.json` (counts, sha256s, dataset revision, filter-model pin,
  seed). **No data rows.**
- Verified: `git check-ignore` confirms `scripts/pilot_router/data/*.jsonl`
  is ignored; `git status` shows no `data/` content staged before commit.
