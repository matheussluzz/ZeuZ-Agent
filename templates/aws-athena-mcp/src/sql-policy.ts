const FORBIDDEN = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'CREATE', 'ALTER', 'DROP', 'UNLOAD', 'MSCK', 'VACUUM', 'OPTIMIZE', 'PREPARE', 'EXECUTE', 'CALL', 'ANALYZE']);

function stripLiteralsAndComments(sql: string): string {
  let output = '';
  let index = 0;
  while (index < sql.length) {
    const current = sql[index];
    const next = sql[index + 1];
    if (current === '-' && next === '-') {
      index += 2;
      while (index < sql.length && sql[index] !== '\n') index += 1;
      output += ' ';
      continue;
    }
    if (current === '/' && next === '*') {
      const end = sql.indexOf('*/', index + 2);
      if (end < 0) throw new Error('Unterminated block comment.');
      index = end + 2;
      output += ' ';
      continue;
    }
    if (current === "'" || current === '"') {
      const quote = current;
      output += quote === "'" ? "''" : '""';
      index += 1;
      let closed = false;
      while (index < sql.length) {
        if (sql[index] === quote && sql[index + 1] === quote) {
          index += 2;
          continue;
        }
        if (sql[index] === quote) {
          index += 1;
          closed = true;
          break;
        }
        index += 1;
      }
      if (!closed) throw new Error('Unterminated quoted value or identifier.');
      continue;
    }
    output += current;
    index += 1;
  }
  return output;
}

export function validateDatasetReadOnlySql(sql: string): { normalized: string; kind: 'query' | 'metadata' | 'explain' } {
  if (!sql.trim() || sql.length > 100_000) throw new Error('SQL must be non-empty and at most 100,000 characters.');
  const stripped = stripLiteralsAndComments(sql);
  const semicolons = [...stripped.matchAll(/;/g)].map((match) => match.index ?? 0);
  if (semicolons.length > 1 || (semicolons.length === 1 && stripped.slice((semicolons[0] ?? 0) + 1).trim())) throw new Error('Only one SQL statement is allowed.');
  const normalized = stripped.replace(/;\s*$/, '').replace(/\s+/g, ' ').trim();
  let depth = 0;
  for (const character of normalized) {
    if (character === '(') depth += 1;
    if (character === ')') depth -= 1;
    if (depth < 0) throw new Error('Unbalanced parentheses.');
  }
  if (depth !== 0) throw new Error('Unbalanced parentheses.');
  const words = normalized.match(/[A-Za-z_][A-Za-z0-9_]*/g)?.map((word) => word.toUpperCase()) ?? [];
  const forbidden = words.filter((word) => FORBIDDEN.has(word));
  if (forbidden.length) throw new Error(`Forbidden SQL operation: ${[...new Set(forbidden)].join(', ')}.`);
  const first = words[0];
  if (first === 'SHOW' || first === 'DESCRIBE' || first === 'DESC') return { normalized, kind: 'metadata' };
  if (first === 'EXPLAIN') {
    if (!words.includes('SELECT')) throw new Error('EXPLAIN is allowed only for a SELECT query.');
    return { normalized, kind: 'explain' };
  }
  if (first === 'SELECT') return { normalized, kind: 'query' };
  if (first === 'WITH' && words.includes('SELECT')) return { normalized, kind: 'query' };
  throw new Error('Statement is outside the dataset-read-only allowlist.');
}
