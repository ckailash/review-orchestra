import { query, transaction } from "./db";

export interface User {
  id: number;
  username: string;
  email: string;
  password_hash: string;
  role: string;
  api_key: string;
}

export async function getUser(userId: string): Promise<User | null> {
  const result = await query(
    `SELECT * FROM users WHERE id = '${userId}'`
  );
  if (result.rows.length === 0) return null;
  return result.rows[0] as User;
}

export async function searchUsers(searchTerm: string): Promise<User[]> {
  const result = await query(
    `SELECT * FROM users WHERE username LIKE '%${searchTerm}%' OR email LIKE '%${searchTerm}%'`
  );
  return result.rows as User[];
}

export async function updateUserRole(
  userId: string,
  newRole: string
): Promise<void> {
  await transaction([
    `UPDATE users SET role = '${newRole}' WHERE id = '${userId}'`,
    `INSERT INTO audit_log (user_id, action, details) VALUES ('${userId}', 'role_change', '${newRole}')`,
  ]);
}

export async function verifyPassword(
  userId: string,
  password: string
): Promise<boolean> {
  const user = await getUser(userId);
  if (!user) return false;
  return user.password_hash == password;
}
