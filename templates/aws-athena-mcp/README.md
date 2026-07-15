# AWS Athena MCP template

This is a deliberately narrow, local `stdio` template for dataset-read-only Athena analysis. It is not connected to or tested against an AWS account in the ZeuZ repository.

It exposes STS identity, selected Glue metadata, workgroup inspection, `EXPLAIN`, confirmed `SELECT`, status/results, and cancellation. It intentionally excludes arbitrary S3 reads, DDL/DML, named-query administration, crawlers, jobs, role assumption, and global query history.

`StartQueryExecution` is classified as an IAM write action, creates results, and can incur cost even for source-data `SELECT`. The SQL guard is conservative defense in depth; least-privilege IAM, Lake Formation, a dedicated workgroup, encryption, and per-query cutoffs remain hard boundaries.

## Local setup

1. Copy `.env.example` into your private environment or MCP host configuration.
2. Authenticate through the normal AWS SDK provider chain, preferably IAM Identity Center/SSO. Never pass credentials as tool arguments.
3. Review `iam-policy.example.json` and replace every placeholder with your exact account, catalog, database, table, workgroup, KMS key, and dataset prefix.
4. Install, build, and test:

```bash
pnpm install
pnpm build
pnpm test
```

5. Run the MCP host and call `aws_identity` before any query. Verify account, ARN, region, and workgroup.

Managed Athena results are the default recommendation for a new deployment because they reduce bucket permissions. If the workgroup requires a customer bucket, configure a narrow output prefix, encryption, lifecycle expiration, and incomplete multipart cleanup.

Primary references are recorded in `skills/atena/references/athena-safety.md` and the repository research notes.
