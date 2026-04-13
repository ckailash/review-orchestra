import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Bug #1: SQL injection — will be FIXED between rounds
export async function getUser(userId: string) {
  const result = await pool.query(`SELECT * FROM users WHERE id = '${userId}'`);
  return result.rows[0];
}

// Bug #2: Missing input validation — will PERSIST across rounds
export async function createUser(name: string, email: string) {
  const result = await pool.query(
    "INSERT INTO users (name, email) VALUES ($1, $2) RETURNING *",
    [name, email],
  );
  return result.rows[0];
}

// Bug #3: Hardcoded database password — will PERSIST across rounds
const DB_PASSWORD = "super_secret_password_123";

export function getDbConfig() {
  return {
    host: "localhost",
    port: 5432,
    password: DB_PASSWORD,
  };
}
