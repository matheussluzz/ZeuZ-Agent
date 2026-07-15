# Plain-language verification

## Risk and depth

| Tier | Examples | Minimum verification |
| --- | --- | --- |
| Low | reversible internal update | self-check against meaning contract |
| Medium | customer guidance, product decision, financial estimate | independent reader or reviewer plus invariant check |
| High | legal, regulatory, medical, safety, employment, binding commitment | subject-matter owner approves exact source and translation; retain original language |

Plain language reduces comprehension friction. It does not reduce the underlying risk or transfer approval authority to the writer.

## Semantic invariants

- Preserve every number, currency, unit, percentage, date, entity, condition, exception, negation, obligation, uncertainty marker, and citation.
- Expand non-trivial acronyms on first use.
- Keep exact technical/legal terms and explain them in context.
- Never change `must` to `should`, `may` to `will`, correlation to causation, or an estimate to a promise.
- Preserve the population, denominator, baseline, time window, exclusions, and comparison method behind every metric.
- Preserve who acts, who is affected, what triggers the action, and what happens when a condition is not met.
- Keep quoted language visibly distinct from paraphrase. Do not fabricate a quote by tightening prose.

## Meaning-contract matrix

| Source item | Translation test |
| --- | --- |
| Fact or observed result | Same scope, units, period, denominator, and source |
| Requirement or prohibition | Same actor, force, trigger, exception, and consequence |
| Estimate or forecast | Same horizon, method boundary, interval/confidence, and caveat |
| Risk | Same likelihood/impact basis; no invented severity |
| Recommendation | Evidence and decision owner remain explicit |
| Unknown or conflict | Remains unknown/conflicted; never smoothed over |

## Commercial structure

1. What it means
2. Why it matters
3. Confirmed impact
4. Decision or action needed
5. Risks and limits
6. Next step
7. Small glossary when useful

Mark commercial impact as inference unless direct evidence supports it. Automated readability scores are diagnostics, not proof of understanding. Ask a representative reader to paraphrase and iterate at least twice for high-impact material.

## Channel and accessibility

- Put the decision/action and deadline before background in email, chat, and executive summaries.
- Use semantic headings and lists; make link text describe the destination.
- Do not encode meaning only with color, layout, icon, humor, metaphor, or cultural knowledge.
- For an example, map each element back to the real mechanism and state where the analogy stops.
- For multilingual output, validate locale-specific number/date formatting and have a competent speaker review high-impact text.

## Verification questions

Ask a representative reader, without showing the expected answer:

1. What does this mean in your own words?
2. What must you decide or do, and by when?
3. What is known, estimated, and still unknown?
4. Which condition or exception could change the answer?

Record misunderstandings as defects in the message, not defects in the reader.

## Primary sources

- Digital.gov plain-language principles: https://digital.gov/guides/plain-language/principles
- Digital.gov comprehension testing: https://digital.gov/guides/plain-language/test
- W3C accessible writing: https://www.w3.org/WAI/tips/writing/
- GOV.UK content design: https://guidance.publishing.service.gov.uk/writing-to-gov-uk-standards/plan-manage-content/understand-content-design/
- U.S. Plain Language Guidelines: https://www.plainlanguage.gov/guidelines/
