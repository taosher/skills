# Process Methodology in Detail

This file explains why the workflow established by project-bootstrap works, its full lifecycle, and its key mechanisms. Read it when introducing the process to a team or when questions come up while following it.

## One-Sentence Summary

**Humans make decisions and accept results; AI analyzes and executes. Every agreement lands in a document first, every piece of work lands in a list first, and every completion must have verification evidence.**

The daily loop is just these five steps:

```
① Decisions form in conversation → ② written into the design doc (single source of truth)
→ ③ decomposed into fine-grained TODOs (single list)
→ ④ implement + verify item by item → ⑤ write back status and lessons (TODOS / AGENTS / doc sync)
```

## The Five Pillars

### Pillar 1: Design Document First (Single Source of Truth)

- The first action is reading the template and writing the design—not writing code. The design doc and its companion references are the single source of truth; when code and doc conflict, the doc wins.
- **Design is interrogated out of conversation**: continuous product-perspective challenges ("What problem does this solve?" "How does it fail in the worst case?"), with AI doing option analysis and impact assessment and the human making the call—each conclusion is written back into the doc immediately. The most valuable design decisions are shaped this way, not written in one pass.
- **Decisions need records**: key decision points highlighted, an alternatives table with rejection reasons, and a version change log preserving history.
- **Examples are part of the contract**: YAML/JSON examples in the doc are not decoration—changing a field means updating the examples, and every revision re-validates all code blocks with a script.
- **Big revisions ship as a "review edition" first**: a review edition for multiple roles (product/frontend/backend/ops/delivery) is strictly additive, carries a reader's guide, and highlights key decisions; after review comments are addressed item by item, it is formalized and merged back into the single doc.

### Pillar 2: AGENTS.md—Living Conventions

Not a file written once, but a living document that **grows one entry per pitfall**:

- **Iron rules**: docs first, single TODO list, language conventions, comment conventions;
- **Facts you must know before implementing**: naming rules, environment details, architecture invariants;
- **Pitfall log accumulates continuously**: every entry comes from a real incident; written down once, never hit twice;
- **Facts go stale**: re-check periodically (phrases like "done / not started yet" expire the fastest).

### Pillar 3: TODOS.md—Single Task List

- Before starting, write the task and set it `in_progress` (only one globally); mark `done` only after code is complete and tests pass; never announce completion only in conversation.
- **Granularity is discipline**: split down to "one item per single-point feature", each with a **verification column** (what proves it is done). An unclear verification standard means the task is not decomposed yet.
- **Tabular + converged statuses**: `ID | Task | Status | Verification`; open questions belong in the list too, or they will be forgotten.
- The list doubles as the AI's **working memory**: after context compaction, reading TODOS tells it where things stand and what comes next.

### Pillar 4: Verification Loop (Evidence at Every Step)

- **Layered verification**: unit tests → integration tests → real-environment end-to-end (E2E assertions).
- **Gap analysis against the design**: periodically compare "design claims vs code reality" chapter by chapter and produce an explicit gap list, so "doc ahead of code" never becomes hidden debt.
- **Docs get verified too**: validate all YAML/JSON/mermaid blocks; run humanizer-style review to strip AI flavor.
- **Demos expose real problems**: treat "can be demoed to others" as an acceptance criterion—problems that only appear in real use (missing config, CORS, build steps dropping assets) surface during demo preparation.

### Pillar 5: Human-AI Division of Labor

| Role | Responsibilities |
|---|---|
| Human (product/architecture) | Provide real scenarios, challenge options, make the call, accept results |
| AI | Option analysis and comparison, impact assessment, fine-grained decomposition, implementation, item-by-item verification, proactively surfacing problems |

- **AI surfaces problems proactively**: fix and explain immediately upon discovery; do not wait for the user to find them;
- **When unsure, ask—never guess**: points the user has not decided are listed explicitly as pending, not implemented unilaterally;
- **Decisions are visible**: every recommendation carries its reasoning and cost, so a human can decide in 30 seconds.

## Full Lifecycle

```
Idea / scenario
  → Design doc (multiple interrogation rounds + decision records + example contracts)
  → (Big revisions) Review edition (multi-role, key decisions highlighted)
  → Review comments addressed item by item → merged into the single doc (formalized)
  → Gap analysis → fine-grained TODOs (each with verification standard)
  → Implement item by item (doc first → code → tests)
  → Layered verification + end-to-end + demo script
  → Write back: TODOS status / AGENTS lessons / companion doc sync
```

## Key Mechanisms

- **Decision records**: key decision highlights + alternatives table (with rejection reasons) + version change log—months later, why the design is the way it is has an answer;
- **Gap list**: differences between design claims and code reality are managed explicitly (as TODOs), so the doc never drifts;
- **Contract management**: examples are the contract; terminology is unified (the companion reference's glossary is authoritative);
- **Demo-driven**: write a demo guide (environment prep + demo scenarios + FAQ) and make "can demo it" the final acceptance.

## Why This Process Works Especially Well for AI Collaboration

1. **Stable context**: single source of truth + the facts section of AGENTS.md externalize "everything the AI should know" into files—it stays on track across sessions and after context compaction;
2. **Blocks typical AI failure modes**: prevents "announcing done" (TODOS verification column), "coarse-grained hand-waving" (single-point tasks), "forgetting the rules" (iron rules), and "doc drift" (gap list + example validation);
3. **Traceable decisions**: the change log and alternatives table are the decision journal;
4. **Humans do only what cannot be replaced**: make the call, accept results, provide real scenarios; everything else goes to the AI and stays verifiable.

## Reusable Checklist for Other Projects

1. Create four things before anything else: `AGENTS.md` (iron rules + facts + pitfalls), design doc (with template anchor), `TODOS.md` (table + verification column), `.gitignore` (secrets defense line);
2. Every feature starts with design interrogation; conclusions go back into the doc before any code;
3. Decompose tasks to single points, each stating "what is the evidence of completion";
4. Run verification after each batch (unit → integration → real pipeline), then a "doc vs code" gap analysis;
5. Write back to AGENTS.md the moment a pitfall is hit; correct stale facts immediately;
6. Make "can demo it to others" the final acceptance;
7. Clean up periodically: merge docs, correct statuses, delete redundancy.
