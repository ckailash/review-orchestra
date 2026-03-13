import { db } from "./db";
import { Request, Response } from "express";

// BUG [nitpick]: Inconsistent naming — mixes camelCase and snake_case
const max_retries = 3;

interface UserRecord {
  id: number;
  email: string;
  password_hash: string;
  api_key: string;
}

// BUG [critical]: API key leaked in response — returns full user record
// including password_hash and api_key to the client
export async function getUser(req: Request, res: Response): Promise<void> {
  const userId = req.params.id;
  const result = await db.query("SELECT * FROM users WHERE id = $1", [userId]);

  if (result.rows.length === 0) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  // Sends entire row including password_hash and api_key
  res.json(result.rows[0]);
}

// BUG [functional]: Pagination is broken — offset calculation is wrong.
// Page 1 should start at offset 0, but this starts at `pageSize`.
export async function listUsers(req: Request, res: Response): Promise<void> {
  const page = parseInt(req.query.page as string) || 1;
  const pageSize = 20;
  const offset = page * pageSize; // Should be (page - 1) * pageSize

  const result = await db.query(
    "SELECT id, email FROM users ORDER BY id LIMIT $1 OFFSET $2",
    [pageSize, offset],
  );

  res.json({ users: result.rows, page, pageSize });
}

// BUG [quality]: No error handling — db errors will crash with unhandled
// promise rejection instead of returning a proper error response
export async function deleteUser(req: Request, res: Response): Promise<void> {
  const userId = req.params.id;
  await db.query("DELETE FROM users WHERE id = $1", [userId]);
  res.status(204).send();
}
