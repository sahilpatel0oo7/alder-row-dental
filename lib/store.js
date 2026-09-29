// All clinic data lives in one Netlify Blobs store with strong consistency.
//
//   slot/<date>/<HH:MM>/<dentist>   -> { ref }   one per occupied 30-min chair slot; created with
//                                               onlyIfNew, so two bookings can never claim the same slot
//   appt/<date>/<ref>               -> appointment (or blocked time)
//   ref/<ref>                       -> { date }  lookup from reference to appointment
//   notif/<ref>/<id>                -> alert delivery log
//   staff/<phone>                   -> staff account (phone digits = login)
//   session/<phone>/<sha(token)>    -> { expiresAt }
//   feedback/<id>                   -> patient feedback
import crypto from "node:crypto";
import { getStore } from "@netlify/blobs";
import { phoneDigits } from "../public/shared/schedule.js";

const store = () => getStore({ name: "clinic", consistency: "strong" });
const now = () => new Date().toISOString();
const id = () => `${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
const hm = t => t.replace(":", "");            // keys avoid ":"
const unhm = t => `${t.slice(0, 2)}:${t.slice(2)}`;

async function listKeys(prefix) {
  const keys = [];
  for await (const page of store().list({ prefix, paginate: true })) for (const b of page.blobs) keys.push(b.key);
  return keys;
}
const getJSON = key => store().get(key, { type: "json" });
const mapLimit = async (items, n, fn) => { const out = []; for (let i = 0; i < items.length; i += n) out.push(...await Promise.all(items.slice(i, i + n).map(fn))); return out; };

/* ---------- bookings ---------- */
export async function busyFor(date) {
  const busy = {};
  for (const k of await listKeys(`slot/${date}/`)) { const [, , t, doc] = k.split("/"); (busy[doc] ||= []).push(unhm(t)); }
  return busy;
}

export async function refExists(ref) { return !!(await getJSON(`ref/${ref}`)); }

export async function getAppt(ref) {
  const idx = await getJSON(`ref/${ref}`);
  return idx ? getJSON(`appt/${idx.date}/${ref}`) : null;
}

/** Give `times` on appt.date to the first dentist in `candidates` who is free for all of them.
 *  Each slot is claimed with an atomic create-if-absent; a partial claim is rolled back. */
export async function claim(appt, times, candidates) {
  const s = store();
  for (const dentist of candidates) {
    const got = [];
    let ok = true;
    for (const t of times) {
      const key = `slot/${appt.date}/${hm(t)}/${dentist}`;
      const r = await s.setJSON(key, { ref: appt.ref }, { onlyIfNew: true });
      if (!r.modified) { ok = false; break; }
      got.push(key);
    }
    if (!ok) { await Promise.all(got.map(k => s.delete(k))); continue; }
    const saved = { ...appt, dentist, createdAt: now(), updatedAt: now() };
    await s.setJSON(`appt/${appt.date}/${appt.ref}`, saved);
    await s.setJSON(`ref/${appt.ref}`, { date: appt.date });
    return saved;
  }
  return null;
}

function runTimes(from, to) { const out = []; const m = x => { const [h, mm] = x.split(":").map(Number); return h * 60 + mm; }; for (let v = m(from); v < m(to); v += 30) out.push(`${String(Math.floor(v / 60)).padStart(2, "0")}:${String(v % 60).padStart(2, "0")}`); return out; }

export async function cancel(ref) {
  const a = await getAppt(ref);
  if (!a) return null;
  const s = store();
  await Promise.all(runTimes(a.time, a.end).map(t => s.delete(`slot/${a.date}/${hm(t)}/${a.dentist}`)));
  const out = { ...a, status: "cancelled", updatedAt: now() };
  await s.setJSON(`appt/${a.date}/${ref}`, out);
  return out;
}

export async function setStatus(ref, status) {
  const a = await getAppt(ref);
  if (!a) return null;
  const out = { ...a, status, updatedAt: now() };
  await store().setJSON(`appt/${a.date}/${ref}`, out);
  return out;
}

/** Active bookings/blocks holding any of `times` for one dentist (for clash messages). */
export async function clashes(date, dentist, times) {
  const refs = new Set();
  await Promise.all(times.map(async t => { const r = await getJSON(`slot/${date}/${hm(t)}/${dentist}`); if (r) refs.add(r.ref); }));
  return (await Promise.all([...refs].map(getAppt))).filter(Boolean);
}

export async function listAppointments() {
  const [apptKeys, notifKeys] = await Promise.all([listKeys("appt/"), listKeys("notif/")]);
  const [appts, notifs] = await Promise.all([mapLimit(apptKeys, 25, getJSON), mapLimit(notifKeys, 25, getJSON)]);
  const byRef = {};
  for (const n of notifs.filter(Boolean).sort((a, b) => a.createdAt.localeCompare(b.createdAt))) (byRef[n.ref] ||= []).push(n);
  return appts.filter(Boolean).map(a => ({ ...a, notifications: byRef[a.ref] || [] }))
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
}

export async function logNotification({ ref, event, channel, target, status, error }) {
  await store().setJSON(`notif/${ref || "none"}/${id()}`, { ref: ref || null, event, channel, target, status, error: error ? String(error).slice(0, 500) : null, createdAt: now() });
}

/* ---------- staff accounts & sessions ---------- */
export const MIN_PASSWORD = 8;
export function loginNumber(phone, cc) { let d = phoneDigits(phone).replace(/^0+/, ""); return d.length === 10 && cc ? cc + d : d; }

function hashPassword(pw) { const salt = crypto.randomBytes(16); return `scrypt$${salt.toString("hex")}$${crypto.scryptSync(pw, salt, 64).toString("hex")}`; }
function checkPassword(pw, stored) {
  const [, saltHex, keyHex] = String(stored).split("$");
  if (!saltHex || !keyHex) return false;
  return crypto.timingSafeEqual(crypto.scryptSync(pw, Buffer.from(saltHex, "hex"), 64), Buffer.from(keyHex, "hex"));
}
const DUMMY = hashPassword(crypto.randomBytes(12).toString("hex"));
const sha = t => crypto.createHash("sha256").update(t).digest("hex");
const publicStaff = s => s && ({ id: s.phone, name: s.name, phone: s.phone, createdAt: s.createdAt, createdBy: s.createdBy, lastLogin: s.lastLogin || null });

export async function listStaff() { return (await mapLimit(await listKeys("staff/"), 25, getJSON)).filter(Boolean).map(publicStaff).sort((a, b) => a.name.localeCompare(b.name)); }
export async function staffCount() { return (await listKeys("staff/")).length; }

/** Returns the new account, or null if that phone number is already used. */
export async function addStaff({ name, phone, password, createdBy }) {
  const rec = { name, phone, passHash: hashPassword(password), createdAt: now(), createdBy: createdBy || null, lastLogin: null };
  const r = await store().setJSON(`staff/${phone}`, rec, { onlyIfNew: true });
  return r.modified ? publicStaff(rec) : null;
}

export async function removeStaff(phone) {
  if ((await staffCount()) <= 1) throw new Error("You can't remove the last staff account.");
  const s = store();
  if (!(await getJSON(`staff/${phone}`))) throw new Error("That staff member no longer exists.");
  await s.delete(`staff/${phone}`);
  await Promise.all((await listKeys(`session/${phone}/`)).map(k => s.delete(k)));   // signs them out everywhere
}

export async function verifyPassword(phone, pw) { const s = await getJSON(`staff/${phone}`); return !!s && checkPassword(pw, s.passHash); }
export async function setPassword(phone, pw) {
  const s = await getJSON(`staff/${phone}`);
  if (s) await store().setJSON(`staff/${phone}`, { ...s, passHash: hashPassword(pw) });
}

const SESSION_HOURS = 12;
export async function login(phone, pw) {
  const s = await getJSON(`staff/${phone}`);
  const ok = checkPassword(pw, s ? s.passHash : DUMMY);
  if (!s || !ok) return null;
  const token = `${phone}.${crypto.randomBytes(32).toString("base64url")}`;
  await store().setJSON(`session/${phone}/${sha(token)}`, { expiresAt: Date.now() + SESSION_HOURS * 3600e3 });
  await store().setJSON(`staff/${phone}`, { ...s, lastLogin: now() });
  return { token, staff: publicStaff(s), maxAge: SESSION_HOURS * 3600 };
}
export async function staffForToken(token) {
  const phone = String(token || "").split(".")[0];
  if (!phone || !/^\d{7,15}$/.test(phone)) return null;
  const sess = await getJSON(`session/${phone}/${sha(token)}`);
  if (!sess || sess.expiresAt < Date.now()) return null;
  return publicStaff(await getJSON(`staff/${phone}`));
}
export async function logout(token) { const phone = String(token || "").split(".")[0]; if (/^\d{7,15}$/.test(phone)) await store().delete(`session/${phone}/${sha(token)}`); }
export async function logoutOthers(phone, keepToken) {
  const keep = `session/${phone}/${sha(keepToken || "")}`;
  await Promise.all((await listKeys(`session/${phone}/`)).filter(k => k !== keep).map(k => store().delete(k)));
}

/* ---------- login attempt limiter (shared across function instances) ---------- */
export async function tooManyLogins(ip) {
  const key = `ratelimit/login/${sha(ip || "unknown")}`;
  const r = (await getJSON(key)) || { n: 0, since: Date.now() };
  const fresh = Date.now() - r.since > 15 * 60e3 ? { n: 0, since: Date.now() } : r;
  fresh.n += 1;
  await store().setJSON(key, fresh);
  return fresh.n > 10;
}

/* ---------- feedback ---------- */
export async function addFeedback(f) { const k = id(); await store().setJSON(`feedback/${k}`, { id: k, ...f, createdAt: now() }); }
export async function listFeedback() {
  const items = (await mapLimit(await listKeys("feedback/"), 25, getJSON)).filter(Boolean).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { items, count: items.length, average: items.length ? items.reduce((s, f) => s + f.rating, 0) / items.length : null };
}
export async function deleteFeedback(k) { await store().delete(`feedback/${k}`); }
