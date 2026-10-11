export interface CopyColumn {
  column_name: string;
  udt_name: string;
}

function quoteIdent(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

/**
 * Read JSON/JSONB as raw JSON text when copying between PostgreSQL databases.
 * node-postgres decodes JSON arrays to JavaScript arrays, which it then
 * serializes as PostgreSQL arrays in bound INSERT parameters, causing
 * "invalid input syntax for type json". Text casts also preserve the
 * distinction between SQL NULL and the JSON literal null.
 */
export function sourceCopySelection(columns: CopyColumn[]): string {
  return columns.map(({ column_name, udt_name }) => {
    const name = quoteIdent(column_name);
    return udt_name === "json" || udt_name === "jsonb"
      ? `${name}::text AS ${name}`
      : name;
  }).join(", ");
}
