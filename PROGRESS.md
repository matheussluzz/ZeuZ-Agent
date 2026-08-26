# ZeuZ progress ledger

This tracked, append-only file is the public history for substantive ZeuZ tasks and monitorable checkpoints. The private `handoff.md` stores only the minimum state needed to resume; consult this ledger on demand with `rg` or `grep` when historical detail is needed.

Each entry starts with a UTC UTID in this exact form:

`YYYYMMDDHHMMSSsss - NNNNN - commit-id`

- `YYYYMMDDHHMMSSsss` is a UTC timestamp with millisecond precision.
- `NNNNN` is the zero-padded task ID. New tasks begin at `00001` and increment by one; later checkpoints for the same task reuse its ID.
- `commit-id` is a 7–40 character Git SHA associated with the checkpoint. A progress-only follow-up commit may record the preceding implementation commit because a commit cannot contain its own final SHA.
- Each entry contains a `Status:` line and must not contain credentials, private paths, raw provider payloads, or confidential material.

## 20260826182754678 - 00001 - fc4f2c7

- Status: started
- Task: synchronize local `main` after the Wave 05 merge and establish the Wave 06 branch for the progress-ledger transition.
- Base: `origin/main` at the Wave 05 merge commit.
