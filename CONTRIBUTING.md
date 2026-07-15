# Contributing to ZeuZ-Agent

Thanks for helping make multi-agent work more honest and reproducible.

## Before opening a change

- Keep provider-specific behavior inside `src/adapters/`.
- Never add real credentials, profiles, vault notes, sessions, or provider event logs.
- Add tests for non-UI behavior and document new slash commands.
- Do not claim a provider/model works without a reproducible current check.
- Use another model family to review material artifacts; include its verdict and the evidence you independently verified.

## Local verification

```bash
pnpm install
pnpm check
pnpm build
node bin/zeuz health
```

Provider changes should include a redacted fixture or a safe real smoke-test record. AWS changes must remain templates unless the contributor has explicit authorization for a test account. Highcharts-related changes must preserve the offline mode and licensing gate.

## Pull requests

Explain the user problem, scope, risks, checks run, provider/account limitations, and adversarial review outcome. `REVIEW_BLOCKED` is acceptable; presenting it as `PASS` is not.
