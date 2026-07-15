#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';

import {
  AthenaClient,
  GetQueryExecutionCommand,
  GetQueryResultsCommand,
  GetWorkGroupCommand,
  StartQueryExecutionCommand,
  StopQueryExecutionCommand,
} from '@aws-sdk/client-athena';
import {
  GetDatabasesCommand,
  GetPartitionsCommand,
  GetTableCommand,
  GetTablesCommand,
  GlueClient,
} from '@aws-sdk/client-glue';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { loadConfig } from './config.js';
import { validateDatasetReadOnlySql } from './sql-policy.js';

const config = loadConfig();
const athena = new AthenaClient({ region: config.region, requestHandler: { requestTimeout: config.timeoutMs } });
const glue = new GlueClient({ region: config.region, requestHandler: { requestTimeout: config.timeoutMs } });
const sts = new STSClient({ region: config.region, requestHandler: { requestTimeout: config.timeoutMs } });
const ownedQueryIds = new Set<string>();
let cachedIdentity: { account: string; arn: string; checkedAt: number } | undefined;

function output(value: Record<string, unknown>) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }], structuredContent: value };
}

function log(event: string, details: Record<string, unknown> = {}): void {
  process.stderr.write(`${JSON.stringify({ time: new Date().toISOString(), event, ...details })}\n`);
}

function requireDatabase(database: string): void {
  if (!config.databases.has(database)) throw new Error(`Database is outside the allowlist: ${database}`);
}

function requireOwnedQuery(queryExecutionId: string): void {
  if (!ownedQueryIds.has(queryExecutionId)) throw new Error('Query ID is not owned by this MCP process.');
}

async function identity(): Promise<{ account: string; arn: string }> {
  if (cachedIdentity && Date.now() - cachedIdentity.checkedAt < 300_000) return cachedIdentity;
  const result = await sts.send(new GetCallerIdentityCommand({}));
  const account = result.Account ?? '';
  const arn = result.Arn ?? '';
  if (!account || account !== config.allowedAccount) throw new Error(`AWS account mismatch. Expected configured account, received ${account || 'unknown'}.`);
  cachedIdentity = { account, arn, checkedAt: Date.now() };
  return cachedIdentity;
}

async function start(sql: string, database: string, parameters: string[] = []): Promise<string> {
  await identity();
  requireDatabase(database);
  const result = await athena.send(new StartQueryExecutionCommand({
    QueryString: sql,
    QueryExecutionContext: { Catalog: config.catalog, Database: database },
    WorkGroup: config.workgroup,
    ClientRequestToken: randomUUID(),
    ...(parameters.length > 0 ? { ExecutionParameters: parameters } : {}),
    ...(config.outputLocation ? { ResultConfiguration: { OutputLocation: config.outputLocation } } : {}),
  }));
  const queryExecutionId = result.QueryExecutionId;
  if (!queryExecutionId) throw new Error('Athena did not return a query execution ID.');
  ownedQueryIds.add(queryExecutionId);
  log('query_started', { queryExecutionId, sqlHash: createHash('sha256').update(sql).digest('hex'), database });
  return queryExecutionId;
}

const server = new McpServer({ name: 'zeuz-athena', version: '0.1.0' });

server.registerTool('aws_identity', {
  description: 'Verify the configured AWS account, caller ARN, region, and Athena workgroup before any data operation.',
  inputSchema: {},
  annotations: { readOnlyHint: true, openWorldHint: true },
}, async () => output({ ...(await identity()), region: config.region, workgroup: config.workgroup, catalog: config.catalog }));

server.registerTool('glue_list_databases', {
  description: 'List only databases permitted by the local allowlist.',
  inputSchema: { nextToken: z.string().optional() },
  annotations: { readOnlyHint: true, openWorldHint: true },
}, async ({ nextToken }) => {
  await identity();
  const result = await glue.send(new GetDatabasesCommand({ CatalogId: config.allowedAccount, MaxResults: 100, ...(nextToken ? { NextToken: nextToken } : {}) }));
  return output({ databases: (result.DatabaseList ?? []).map((database) => database.Name).filter((name): name is string => Boolean(name && config.databases.has(name))), nextToken: result.NextToken });
});

server.registerTool('glue_list_tables', {
  description: 'List tables in an allowlisted Glue database.',
  inputSchema: { database: z.string().min(1), nextToken: z.string().optional() },
  annotations: { readOnlyHint: true, openWorldHint: true },
}, async ({ database, nextToken }) => {
  await identity();
  requireDatabase(database);
  const result = await glue.send(new GetTablesCommand({ CatalogId: config.allowedAccount, DatabaseName: database, MaxResults: 100, ...(nextToken ? { NextToken: nextToken } : {}) }));
  return output({ database, tables: (result.TableList ?? []).map((table) => ({ name: table.Name, type: table.TableType, partitionKeys: table.PartitionKeys?.map((column) => ({ name: column.Name, type: column.Type })) })), nextToken: result.NextToken });
});

server.registerTool('glue_get_table', {
  description: 'Get a verified table schema and partition keys from an allowlisted Glue database.',
  inputSchema: { database: z.string().min(1), table: z.string().min(1) },
  annotations: { readOnlyHint: true, openWorldHint: true },
}, async ({ database, table }) => {
  await identity();
  requireDatabase(database);
  const result = await glue.send(new GetTableCommand({ CatalogId: config.allowedAccount, DatabaseName: database, Name: table }));
  const value = result.Table;
  return output({ database, table: value?.Name, type: value?.TableType, columns: value?.StorageDescriptor?.Columns?.map((column) => ({ name: column.Name, type: column.Type, comment: column.Comment })), partitionKeys: value?.PartitionKeys?.map((column) => ({ name: column.Name, type: column.Type })) });
});

server.registerTool('glue_list_partitions', {
  description: 'List a bounded page of partitions for a verified allowlisted table.',
  inputSchema: { database: z.string().min(1), table: z.string().min(1), expression: z.string().max(2_000).optional(), nextToken: z.string().optional() },
  annotations: { readOnlyHint: true, openWorldHint: true },
}, async ({ database, table, expression, nextToken }) => {
  await identity();
  requireDatabase(database);
  const result = await glue.send(new GetPartitionsCommand({ CatalogId: config.allowedAccount, DatabaseName: database, TableName: table, MaxResults: 25, ExcludeColumnSchema: true, ...(expression ? { Expression: expression } : {}), ...(nextToken ? { NextToken: nextToken } : {}) }));
  return output({ database, table, partitions: (result.Partitions ?? []).map((partition) => partition.Values), nextToken: result.NextToken });
});

server.registerTool('athena_get_workgroup', {
  description: 'Inspect the configured Athena workgroup and its enforced settings.',
  inputSchema: {},
  annotations: { readOnlyHint: true, openWorldHint: true },
}, async () => {
  await identity();
  const result = await athena.send(new GetWorkGroupCommand({ WorkGroup: config.workgroup }));
  return output({ name: result.WorkGroup?.Name, state: result.WorkGroup?.State, configuration: result.WorkGroup?.Configuration });
});

server.registerTool('athena_plan_query', {
  description: 'Run EXPLAIN for a verified SELECT. EXPLAIN reads metadata but not source data; it is not an exact byte dry-run.',
  inputSchema: { database: z.string().min(1), sql: z.string().min(1).max(100_000), parameters: z.array(z.string()).max(50).optional() },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
}, async ({ database, sql, parameters }) => {
  const validated = validateDatasetReadOnlySql(sql);
  if (validated.kind !== 'query') throw new Error('Planning accepts a SELECT or WITH...SELECT query only.');
  const queryExecutionId = await start(`EXPLAIN (TYPE IO, FORMAT JSON) ${sql.replace(/;\s*$/, '')}`, database, parameters);
  return output({ queryExecutionId, status: 'QUEUED', note: 'EXPLAIN is metadata planning, not an exact scan-byte estimate.' });
});

server.registerTool('athena_start_select', {
  description: 'Start a chargeable dataset-read-only SELECT after explicit user confirmation. Creates query results and may incur cost.',
  inputSchema: { database: z.string().min(1), sql: z.string().min(1).max(100_000), parameters: z.array(z.string()).max(50).optional(), confirmed: z.literal(true) },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
}, async ({ database, sql, parameters }) => {
  const validated = validateDatasetReadOnlySql(sql);
  if (validated.kind !== 'query') throw new Error('Execution accepts a SELECT or WITH...SELECT query only.');
  const queryExecutionId = await start(sql, database, parameters);
  return output({ queryExecutionId, status: 'QUEUED' });
});

server.registerTool('athena_get_query_status', {
  description: 'Get status, duration, scanned bytes, reuse, and failure details for a query created by this MCP process.',
  inputSchema: { queryExecutionId: z.string().min(1) },
  annotations: { readOnlyHint: true, openWorldHint: true },
}, async ({ queryExecutionId }) => {
  await identity();
  requireOwnedQuery(queryExecutionId);
  const result = await athena.send(new GetQueryExecutionCommand({ QueryExecutionId: queryExecutionId }));
  const query = result.QueryExecution;
  return output({ queryExecutionId, state: query?.Status?.State, reason: query?.Status?.StateChangeReason, scannedBytes: query?.Statistics?.DataScannedInBytes, engineMs: query?.Statistics?.EngineExecutionTimeInMillis, totalMs: query?.Statistics?.TotalExecutionTimeInMillis, reused: query?.Statistics?.ResultReuseInformation?.ReusedPreviousResult });
});

server.registerTool('athena_get_query_results', {
  description: 'Get a bounded page of results for a successful query created by this MCP process.',
  inputSchema: { queryExecutionId: z.string().min(1), nextToken: z.string().optional(), maxRows: z.number().int().min(1).max(1_000).optional() },
  annotations: { readOnlyHint: true, openWorldHint: true },
}, async ({ queryExecutionId, nextToken, maxRows }) => {
  await identity();
  requireOwnedQuery(queryExecutionId);
  const result = await athena.send(new GetQueryResultsCommand({ QueryExecutionId: queryExecutionId, MaxResults: Math.min(maxRows ?? config.maxRows, config.maxRows), ...(nextToken ? { NextToken: nextToken } : {}) }));
  const columns = result.ResultSet?.ResultSetMetadata?.ColumnInfo?.map((column) => ({ name: column.Name, type: column.Type })) ?? [];
  const rows = (result.ResultSet?.Rows ?? []).map((row) => row.Data?.map((cell) => cell.VarCharValue ?? null) ?? []);
  return output({ queryExecutionId, columns, rows, nextToken: result.NextToken, truncated: Boolean(result.NextToken) });
});

server.registerTool('athena_cancel_query', {
  description: 'Cancel a running query created by this MCP process. Already-scanned data can still be billed.',
  inputSchema: { queryExecutionId: z.string().min(1) },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
}, async ({ queryExecutionId }) => {
  await identity();
  requireOwnedQuery(queryExecutionId);
  await athena.send(new StopQueryExecutionCommand({ QueryExecutionId: queryExecutionId }));
  log('query_cancelled', { queryExecutionId });
  return output({ queryExecutionId, cancellationRequested: true });
});

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('server_started', { region: config.region, workgroup: config.workgroup, databaseCount: config.databases.size });
}

process.on('SIGINT', () => void server.close().finally(() => process.exit(0)));
main().catch((error) => {
  log('fatal', { message: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
