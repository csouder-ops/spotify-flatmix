import path from 'path';
import fs from 'fs';
import Database from 'better-sqlite3';
import { decrypt, encrypt } from './crypto';

export interface StoredUser {
  flatCode: string;
  userId: string;
  displayName: string;
  accessToken: string;
  refreshTokenEncrypted: string;
  tokenExpiry: number;
  lastJoined: string;
  contributionCount: number;
}

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'flatmix.db');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    flat_code TEXT NOT NULL,
    user_id TEXT NOT NULL,
    display_name TEXT,
    access_token TEXT NOT NULL,
    refresh_token TEXT NOT NULL,
    token_expiry INTEGER NOT NULL,
    last_joined TEXT NOT NULL,
    contribution_count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (flat_code, user_id)
  )
`);

const upsertUserStmt = db.prepare(`
  INSERT INTO users (flat_code, user_id, display_name, access_token, refresh_token, token_expiry, last_joined, contribution_count)
  VALUES (@flat_code, @user_id, @display_name, @access_token, @refresh_token, @token_expiry, @last_joined, @contribution_count)
  ON CONFLICT(flat_code, user_id) DO UPDATE SET
    display_name=excluded.display_name,
    access_token=excluded.access_token,
    refresh_token=excluded.refresh_token,
    token_expiry=excluded.token_expiry,
    last_joined=excluded.last_joined
`);

const getUserStmt = db.prepare<[{ flat: string; user: string }], StoredUser | undefined>(
  `SELECT flat_code as flatCode, user_id as userId, display_name as displayName, access_token as accessToken,
          refresh_token as refreshTokenEncrypted, token_expiry as tokenExpiry, last_joined as lastJoined,
          contribution_count as contributionCount
     FROM users
    WHERE flat_code = @flat AND user_id = @user`
);

const listUsersStmt = db.prepare<[{ flat: string }], StoredUser>(
  `SELECT flat_code as flatCode, user_id as userId, display_name as displayName, access_token as accessToken,
          refresh_token as refreshTokenEncrypted, token_expiry as tokenExpiry, last_joined as lastJoined,
          contribution_count as contributionCount
     FROM users
    WHERE flat_code = @flat
    ORDER BY datetime(last_joined) DESC`
);

const updateContributionStmt = db.prepare(`
  UPDATE users SET contribution_count = @count WHERE flat_code = @flat AND user_id = @user
`);

const deleteFlatStmt = db.prepare(`DELETE FROM users WHERE flat_code = ?`);

export function upsertUser(data: {
  flatCode: string;
  userId: string;
  displayName: string;
  accessToken: string;
  refreshToken: string;
  tokenExpiry: number;
  lastJoined: string;
}): void {
  upsertUserStmt.run({
    flat_code: data.flatCode,
    user_id: data.userId,
    display_name: data.displayName,
    access_token: data.accessToken,
    refresh_token: encrypt(data.refreshToken),
    token_expiry: data.tokenExpiry,
    last_joined: data.lastJoined,
    contribution_count: 0,
  });
}

export function updateUserTokens(data: {
  flatCode: string;
  userId: string;
  accessToken: string;
  refreshToken?: string;
  tokenExpiry: number;
}): void {
  const record = getUserStmt.get({ flat: data.flatCode, user: data.userId });
  if (!record && !data.refreshToken) {
    throw new Error(`Cannot update tokens for unknown user ${data.userId}`);
  }
  const refreshTokenEncrypted = data.refreshToken ? encrypt(data.refreshToken) : record?.refreshTokenEncrypted;
  const stmt = db.prepare(`
    UPDATE users
       SET access_token = @access_token,
           refresh_token = @refresh_token,
           token_expiry = @token_expiry
     WHERE flat_code = @flat_code AND user_id = @user_id
  `);
  stmt.run({
    flat_code: data.flatCode,
    user_id: data.userId,
    access_token: data.accessToken,
    refresh_token: refreshTokenEncrypted,
    token_expiry: data.tokenExpiry,
  });
}

export function setContributionCount(flatCode: string, userId: string, count: number): void {
  updateContributionStmt.run({ flat: flatCode, user: userId, count });
}

export function getUsersByFlat(flatCode: string): StoredUser[] {
  return listUsersStmt.all({ flat: flatCode });
}

export function getDecryptedRefreshToken(user: StoredUser): string {
  return decrypt(user.refreshTokenEncrypted);
}

export function resetFlat(flatCode: string): void {
  deleteFlatStmt.run(flatCode);
}
