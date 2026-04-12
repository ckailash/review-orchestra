export interface QueryResult {
  rows: Record<string, unknown>[];
  rowCount: number;
}

export interface Client {
  query(text: string, params?: unknown[]): Promise<QueryResult>;
}

interface Pool {
  query(text: string, params?: unknown[]): Promise<QueryResult>;
  connect(): Promise<Client & { release(): void }>;
}

let pool: Pool | null = null;

export function initPool(connectionString: string): void {
  // In a real app, this would create a pg.Pool
  // Stub for eval fixture
  const stubClient: Client & { release(): void } = {
    async query(text: string, params?: unknown[]): Promise<QueryResult> {
      void text;
      void params;
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };

  pool = {
    async query(text: string, params?: unknown[]): Promise<QueryResult> {
      void text;
      void params;
      return { rows: [], rowCount: 0 };
    },
    async connect() {
      return stubClient;
    },
  };
  void connectionString;
}

function getPool(): Pool {
  if (!pool) {
    throw new Error("Database pool not initialized. Call initPool() first.");
  }
  return pool;
}

export const db = {
  async query(text: string, params?: unknown[]): Promise<QueryResult> {
    return getPool().query(text, params);
  },
};

export async function withTransaction<T>(
  fn: (client: Client) => Promise<T>
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
