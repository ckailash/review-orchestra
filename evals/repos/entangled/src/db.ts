export interface DbResult {
  rows: Record<string, unknown>[];
}

const pool = {
  query: async (sql: string): Promise<DbResult> => {
    console.log("Executing:", sql);
    return { rows: [] };
  },
};

export async function query(sql: string): Promise<DbResult> {
  return pool.query(sql);
}

export async function transaction(queries: string[]): Promise<void> {
  await pool.query("BEGIN");
  for (const sql of queries) {
    await pool.query(sql);
  }
  await pool.query("COMMIT");
}
