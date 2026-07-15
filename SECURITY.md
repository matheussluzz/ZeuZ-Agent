# Security policy

ZeuZ-Agent is a public alpha that launches third-party agent CLIs with access to a user-selected workspace. It is not a containment boundary for hostile repositories or malicious provider output.

## Reporting a vulnerability

Do not open a public issue for a secret exposure or exploitable sandbox/path escape. Use GitHub's private vulnerability reporting for this repository. Include the affected version, platform, reproduction, impact, and whether any credential may have been exposed. Rotate an exposed credential before reporting it.

## Supported version

Only the latest commit on the default branch receives security fixes during the alpha.

## Security expectations

- Keep `lamine.yaml`, `.env`, `users/*.md`, and real `vault/**` files local and ignored.
- Use `plan` for untrusted review and reserve `yolo` for explicit, understood cases.
- Review provider-native permissions; ZeuZ cannot strengthen every third-party sandbox.
- Run `pnpm secrets:check` before commits and pushes.
