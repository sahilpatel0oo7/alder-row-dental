import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const file = process.env.DB_PATH || "data/clinic.db";
fs.mkdirSync(path.dirname(file), { recursive: true });
export const db = new Database(file);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS appointments (
  ref TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'appt',          -- appt | block
  source TEXT NOT NULL DEFAULT 'online',      -- online | phone | walk-in | other | staff
  service TEXT, service_name TEXT NOT NULL,
  dentist TEXT NOT NULL,
  date TEXT NOT NULL, time TEXT NOT NULL, end_time TEXT NOT NULL,
  name TEXT NOT NULL, phone TEXT, email TEXT,
  new_patient INTEGER NOT NULL DEFAULT 0, dob TEXT, notes TEXT,
  status TEXT NOT NULL,                       -- booked | arrived | done | cancelled | blocked
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS appt_date ON appointments(date, time);

-- One row per occupied 30-minute chair slot. The primary key makes double-booking impossible.
CREATE TABLE IF NOT EXISTS slots (
  date TEXT NOT NULL, time TEXT NOT NULL, dentist TEXT NOT NULL,
  ref TEXT NOT NULL REFERENCES appointments(ref) ON DELETE CASCADE,
  PRIMARY KEY (date, time, dentist)
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ref TEXT, event TEXT NOT NULL, channel TEXT NOT NULL, target TEXT NOT NULL,
  status TEXT NOT NULL, error TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS notif_ref ON notifications(ref);
`);

const now = () => new Date().toISOString();

export function toAppt(r) {
  if (!r) return null;
  return {
    ref: r.ref, kind: r.kind, source: r.source, service: r.service, serviceName: r.service_name,
    dentist: r.dentist, date: r.date, time: r.time, end: r.end_time, name: r.name, phone: r.phone,
    email: r.email, newPatient: !!r.new_patient, dob: r.dob, notes: r.notes, status: r.status,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export function busyFor(date) {
  const busy = {};
  for (const s of db.prepare("SELECT time, dentist FROM slots WHERE date = ?").all(date)) (busy[s.dentist] ||= []).push(s.time);
  return busy;
}

const slotTaken = db.prepare("SELECT ref FROM slots WHERE date = ? AND time = ? AND dentist = ?");
const insSlot = db.prepare("INSERT INTO slots (date, time, dentist, ref) VALUES (?, ?, ?, ?)");
const insAppt = db.prepare(`INSERT INTO appointments
  (ref, kind, source, service, service_name, dentist, date, time, end_time, name, phone, email, new_patient, dob, notes, status, created_at, updated_at)
  VALUES (@ref, @kind, @source, @service, @serviceName, @dentist, @date, @time, @end, @name, @phone, @email, @newPatient, @dob, @notes, @status, @createdAt, @createdAt)`);

/** Atomically give `times` on `date` to the first free dentist in `candidates`.
 *  Returns the saved appointment, or null when every candidate is taken. */
export const claim = db.transaction((appt, times, candidates) => {
  for (const dentist of candidates) {
    if (times.some(t => slotTaken.get(appt.date, t, dentist))) continue;
    const row = { ...appt, dentist, newPatient: appt.newPatient ? 1 : 0, createdAt: now() };
    insAppt.run(row);
    for (const t of times) insSlot.run(appt.date, t, dentist, appt.ref);
    return getAppt(appt.ref);
  }
  return null;
});

export function getAppt(ref) { return toAppt(db.prepare("SELECT * FROM appointments WHERE ref = ?").get(ref)); }

export const cancel = db.transaction(ref => {
  db.prepare("DELETE FROM slots WHERE ref = ?").run(ref);
  db.prepare("UPDATE appointments SET status = 'cancelled', updated_at = ? WHERE ref = ?").run(now(), ref);
  return getAppt(ref);
});

export function setStatus(ref, status) {
  db.prepare("UPDATE appointments SET status = ?, updated_at = ? WHERE ref = ?").run(status, now(), ref);
  return getAppt(ref);
}

/** Active appointments/blocks overlapping `times` for one dentist (for clash messages). */
export function clashes(date, dentist, times) {
  const refs = new Set();
  for (const t of times) { const r = slotTaken.get(date, t, dentist); if (r) refs.add(r.ref); }
  return [...refs].map(getAppt);
}

export function listAppointments({ from, to } = {}) {
  const rows = db.prepare(`SELECT * FROM appointments WHERE date >= ? AND date <= ? ORDER BY date, time`).all(from || "0000-00-00", to || "9999-12-31");
  const notes = db.prepare("SELECT ref, event, channel, status, error, target, created_at FROM notifications WHERE ref IN (SELECT ref FROM appointments WHERE date >= ? AND date <= ?) ORDER BY id").all(from || "0000-00-00", to || "9999-12-31");
  const byRef = {};
  for (const n of notes) (byRef[n.ref] ||= []).push(n);
  return rows.map(r => ({ ...toAppt(r), notifications: byRef[r.ref] || [] }));
}

export function logNotification({ ref, event, channel, target, status, error }) {
  db.prepare("INSERT INTO notifications (ref, event, channel, target, status, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(ref || null, event, channel, target, status, error ? String(error).slice(0, 500) : null, now());
}

export function refExists(ref) { return !!db.prepare("SELECT 1 FROM appointments WHERE ref = ?").get(ref); }
