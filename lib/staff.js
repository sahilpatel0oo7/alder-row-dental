// Staff accounts (phone number + password), login sessions, and patient feedback.
import crypto from "node:crypto";
import { db } from "./db.js";
import { phoneDigits } from "../shared/schedule.js";

db.exec(`
CREATE TABLE IF NOT EXISTS staff (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE,          -- digits only; this is the login
  pass_hash TEXT NOT NULL,
  created_at TEXT NOT NULL, created_by TEXT,
  last_login TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  staff_id INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment TEXT, name TEXT, contact TEXT, ref TEXT,
  created_at TEXT NOT NULL
);
`);

const now = () => new Date().toISOString();
const SESSION_HOURS = 12;
export const MIN_PASSWORD = 8;

/* Login numbers are stored as digits; a 10-digit number gets the clinic's country code so
   "74897 91016" and "+91 74897 91016" are the same account. */
export function loginNumber(phone, cc) { let d = phoneDigits(phone).replace(/^0+/, ""); return d.length === 10 && cc ? cc + d : d; }

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}
function checkPassword(pw, stored) {
  const [, saltHex, keyHex] = String(stored).split("$");
  if (!saltHex || !keyHex) return false;
  const key = crypto.scryptSync(pw, Buffer.from(saltHex, "hex"), 64);
  return crypto.timingSafeEqual(key, Buffer.from(keyHex, "hex"));
}
// Same work whether or not the number exists, so response time doesn't reveal valid numbers.
const DUMMY = hashPassword(crypto.randomBytes(12).toString("hex"));

const publicStaff = s => s && ({ id: s.id, name: s.name, phone: s.phone, createdAt: s.created_at, createdBy: s.created_by, lastLogin: s.last_login });

export function staffCount() { return db.prepare("SELECT COUNT(*) AS n FROM staff").get().n; }
export function listStaff() { return db.prepare("SELECT * FROM staff ORDER BY name COLLATE NOCASE").all().map(publicStaff); }

export function addStaff({ name, phone, password, createdBy }) {
  const s = db.prepare("INSERT INTO staff (name, phone, pass_hash, created_at, created_by) VALUES (?, ?, ?, ?, ?)")
    .run(name, phone, hashPassword(password), now(), createdBy || null);
  return publicStaff(db.prepare("SELECT * FROM staff WHERE id = ?").get(s.lastInsertRowid));
}
export function phoneTaken(phone) { return !!db.prepare("SELECT 1 FROM staff WHERE phone = ?").get(phone); }

export const removeStaff = db.transaction(id => {
  if (staffCount() <= 1) throw new Error("You can't remove the last staff account.");
  const r = db.prepare("DELETE FROM staff WHERE id = ?").run(id);      // their sessions go with them
  if (!r.changes) throw new Error("That staff member no longer exists.");
});

export function setPassword(id, password) {
  db.prepare("UPDATE staff SET pass_hash = ? WHERE id = ?").run(hashPassword(password), id);
}
export function verifyPassword(id, password) {
  const s = db.prepare("SELECT pass_hash FROM staff WHERE id = ?").get(id);
  return !!s && checkPassword(password, s.pass_hash);
}

/** Returns { token, staff } on success, null on a wrong number or password. */
export function login(phone, password) {
  const s = db.prepare("SELECT * FROM staff WHERE phone = ?").get(phone);
  const ok = checkPassword(password, s ? s.pass_hash : DUMMY);
  if (!s || !ok) return null;
  const token = crypto.randomBytes(32).toString("base64url");
  db.prepare("INSERT INTO sessions (token_hash, staff_id, expires_at) VALUES (?, ?, ?)").run(sha(token), s.id, Date.now() + SESSION_HOURS * 3600e3);
  db.prepare("UPDATE staff SET last_login = ? WHERE id = ?").run(now(), s.id);
  return { token, staff: publicStaff(s), maxAge: SESSION_HOURS * 3600 };
}
const sha = t => crypto.createHash("sha256").update(t).digest("hex");

export function staffForToken(token) {
  if (!token) return null;
  const row = db.prepare("SELECT s.* FROM sessions x JOIN staff s ON s.id = x.staff_id WHERE x.token_hash = ? AND x.expires_at > ?").get(sha(token), Date.now());
  return publicStaff(row);
}
export function logout(token) { if (token) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha(token)); }
export function logoutOthers(staffId, keepToken) { db.prepare("DELETE FROM sessions WHERE staff_id = ? AND token_hash != ?").run(staffId, sha(keepToken || "")); }
setInterval(() => db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(Date.now()), 3600e3).unref();

/* ---------- feedback ---------- */
export function addFeedback({ rating, comment, name, contact, ref }) {
  db.prepare("INSERT INTO feedback (rating, comment, name, contact, ref, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(rating, comment || null, name || null, contact || null, ref || null, now());
}
export function listFeedback() {
  const rows = db.prepare("SELECT * FROM feedback ORDER BY id DESC LIMIT 500").all();
  const stats = db.prepare("SELECT COUNT(*) AS n, AVG(rating) AS avg FROM feedback").get();
  return { items: rows.map(r => ({ id: r.id, rating: r.rating, comment: r.comment, name: r.name, contact: r.contact, ref: r.ref, createdAt: r.created_at })), count: stats.n, average: stats.avg };
}
export function deleteFeedback(id) { db.prepare("DELETE FROM feedback WHERE id = ?").run(id); }
