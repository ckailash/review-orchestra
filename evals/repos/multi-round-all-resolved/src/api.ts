import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Bug #1: SQL injection in getUser
export async function getUser(userId: string) {
  const result = await pool.query(`SELECT * FROM users WHERE id = '${userId}'`);
  return result.rows[0];
}

// Bug #2: Hardcoded secret
const API_SECRET = "hardcoded_api_key_12345";

export function getApiConfig() {
  return {
    endpoint: "https://api.example.com",
    secret: API_SECRET,
  };
}
