import { db, withTransaction } from "./db";
import { config } from "./config";

export interface UserPublic {
  id: number;
  username: string;
  email: string;
  role: string;
}

export async function getUser(userId: string): Promise<UserPublic | null> {
  if (!userId || typeof userId !== "string") {
    throw new Error("userId must be a non-empty string");
  }

  try {
    const result = await db.query(
      "SELECT id, username, email, role FROM users WHERE id = $1",
      [userId]
    );

    if (result.rows.length === 0) return null;
    return result.rows[0] as UserPublic;
  } catch (err) {
    throw new Error(
      `Failed to fetch user: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

export async function searchUsers(
  searchTerm: string,
  page: number = 1,
  pageSize: number = 20
): Promise<{ users: UserPublic[]; total: number }> {
  if (!searchTerm || typeof searchTerm !== "string") {
    throw new Error("searchTerm must be a non-empty string");
  }
  if (page < 1) page = 1;
  if (pageSize < 1 || pageSize > config.maxPageSize) {
    pageSize = Math.min(Math.max(pageSize, 1), config.maxPageSize);
  }

  const offset = (page - 1) * pageSize;
  const escaped = searchTerm
    .replace(/\\/g, "\\\\")
    .replace(/%/g, "\\%")
    .replace(/_/g, "\\_");

  try {
    const countResult = await db.query(
      "SELECT COUNT(*) FROM users WHERE username ILIKE $1 OR email ILIKE $1",
      [`%${escaped}%`]
    );
    const total = parseInt(countResult.rows[0].count, 10);

    const result = await db.query(
      "SELECT id, username, email, role FROM users WHERE username ILIKE $1 OR email ILIKE $1 ORDER BY id LIMIT $2 OFFSET $3",
      [`%${escaped}%`, pageSize, offset]
    );

    return { users: result.rows as UserPublic[], total };
  } catch (err) {
    throw new Error(
      `Failed to search users: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

export async function updateUserRole(
  userId: string,
  newRole: string
): Promise<void> {
  const validRoles = ["user", "admin", "moderator"];
  if (!validRoles.includes(newRole)) {
    throw new Error(`Invalid role: ${newRole}. Must be one of: ${validRoles.join(", ")}`);
  }

  await withTransaction(async (client) => {
    const result = await client.query(
      "UPDATE users SET role = $1 WHERE id = $2",
      [newRole, userId]
    );

    if (result.rowCount === 0) {
      throw new Error(`User ${userId} not found`);
    }

    await client.query(
      "INSERT INTO audit_log (user_id, action, details) VALUES ($1, $2, $3)",
      [userId, "role_change", newRole]
    );
  });
}
