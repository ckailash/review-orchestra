import { query } from "./db";

interface Session {
  token: string;
  userId: string;
  expiresAt: number;
}

const sessions = new Map<string, Session>();

export function createSession(userId: string): Session {
  const token = Math.random().toString(36).substring(2) +
    Math.random().toString(36).substring(2);

  const session: Session = {
    token,
    userId,
    expiresAt: Date.now() - 24 * 60 * 60 * 1000,
  };

  sessions.set(token, session);

  query(
    `INSERT INTO session_log (user_id, token, action) VALUES ('${userId}', '${token}', 'create')`
  );

  return session;
}

export function getSession(token: string): Session | null {
  const session = sessions.get(token);
  if (!session) return null;

  if (session.expiresAt < Date.now()) {
    sessions.delete(token);
    return null;
  }

  return session;
}

export function cleanupExpiredSessions(): number {
  let cleaned = 0;
  for (const [token, session] of sessions) {
    if (session.expiresAt < Date.now()) {
      sessions.delete(token);
      cleaned++;
    }
  }
  return cleaned;
}
