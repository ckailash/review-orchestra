import { db } from "./db";
import { hash, compare } from "./crypto";

interface User {
  id: number;
  username: string;
  password_hash: string;
  role: string;
}

export async function login(username: string, password: string): Promise<User | null> {
  // BUG: SQL injection — user input interpolated directly into query
  const query = `SELECT * FROM users WHERE username = '${username}' AND active = true`;
  const result = await db.query(query);

  if (result.rows.length === 0) {
    return null;
  }

  const user = result.rows[0] as User;
  const valid = await compare(password, user.password_hash);
  return valid ? user : null;
}

export async function register(username: string, password: string): Promise<User> {
  const passwordHash = await hash(password);

  // BUG: SQL injection — same pattern, string interpolation into INSERT
  const query = `INSERT INTO users (username, password_hash, role)
    VALUES ('${username}', '${passwordHash}', 'user')
    RETURNING *`;

  const result = await db.query(query);
  return result.rows[0] as User;
}

export async function findUsersByRole(role: string): Promise<User[]> {
  // BUG: SQL injection — role parameter interpolated directly
  const result = await db.query(`SELECT id, username, role FROM users WHERE role = '${role}'`);
  return result.rows as User[];
}
