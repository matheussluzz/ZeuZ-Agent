---
name: hermes
description: Translate complex technical, data, product, legal, or research material into plain, commercially useful language without changing facts, uncertainty, obligations, numbers, or limitations. Use for executive summaries, stakeholder explanations, business-facing documentation, onboarding, or when the user is unfamiliar with the subject.
---

# Hermes

Translate for a real audience and decision. Do not merely shorten the text, infantilize the reader, or turn evidence into marketing.

## Progressive workflow

Load only the stage needed next. Preserve the compact outputs from completed stages instead of repeatedly loading the whole source.

### 1. Freeze the communication brief

Establish audience, demonstrated prior knowledge, channel, desired decision/action, time available, tone, and source authority. Use [assets/communication-brief.md](assets/communication-brief.md). Ask only when a missing choice changes the result. Do not silently optimize for an imagined executive.

**Gate:** name one primary audience and one intended outcome. If there are materially different audiences, create separate versions.

### 2. Build the meaning contract

Extract the source's claims and invariants: numbers, units, currencies, dates, entities, scope, negations, obligations, conditions, exceptions, uncertainty, confidence, citations, and causal language. Classify each statement as source fact, source opinion, or your inference. Keep sensitive details out of examples.

**Gate:** resolve contradictory passages or show the contradiction; do not choose the convenient version.

### 3. Translate in layers

Lead with the answer and why it matters. Follow with confirmed impact, required decision/action, risks and limitations, next step, and a small glossary when useful. Define the exact technical term on first use and expand non-trivial acronyms. Use an example, comparison, or diagram only when it preserves the same mechanism and boundary conditions.

Prefer active voice, short sentences, informative headings, descriptive links, and concrete actors. Keep the original legal, regulatory, contractual, or safety-critical language available beside the explanation; the translation never replaces it.

### 4. Challenge commercial claims

Mark inferred business impact as inference. Never invent return on investment, savings, causality, urgency, certainty, endorsement, or a recommendation. Preserve `must` versus `should`, `may` versus `will`, correlation versus causation, and estimate versus commitment.

### 5. Verify meaning and usability

Run `node scripts/check-invariants.mjs <source> <translation>` as a conservative lexical backstop. Then trace every meaning-contract item into the translation. For high-impact material, ask a representative reader to paraphrase the meaning and intended action without coaching; repair the message and repeat.

**Delivery evidence:** include the audience/outcome, translated artifact, important terms retained, assumptions/inferences, unresolved ambiguity, and verification performed. A readability score or passing invariant script does not prove comprehension or semantic equivalence.

Read [references/plain-language-checklist.md](references/plain-language-checklist.md) for risk tiers, channel checks, examples, and the semantic verification matrix.
