import "dotenv/config";
import express from "express";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import clinic from "./shared/clinic.config.js";
import { runTimes, slotStarts, freeDentists, toMin, hm, ymd, isYmd, isHm, phoneDigits, validPhone, validEmail } from "./shared/schedule.js";
import * as store from "./lib/db.js";
import { notifyClinic, emailPatient, sendTest, notifyStatus } from "./lib/notify.js";
import { chatEnabled, chatReply } from "./lib/chat.js";
import * as staff from "./lib/staff.js";

process.env.TZ = process.env.CLINIC_TZ || "Asia/Kolkata";   // all dates/times are clinic-local
const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const NOTIFY_STAFF = process.env.NOTIFY_ON_STAFF_BOOKINGS === "true";

const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(express.json({ limit: "32kb" }));
app.use((req, res, next) => { res.set({ "X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin", "X-Frame-Options": "DENY" }); next(); });

/* ---------- small helpers ---------- */
const svcById = id => clinic.services.find(s => s.id === id);
const docById = id => clinic.dentists.find(d => d.id === id);
const str = (v, max) => String(v ?? "").trim().slice(0, max);
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
function newRef(prefix = "AR") {
  const a = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  for (;;) { let r = prefix + "-"; for (let i = 0; i < 6; i++) r += a[crypto.randomInt(a.length)]; if (!store.refExists(r)) return r; }
}
const hits = new Map();
function limited(req, key, max, windowMs) {
  const k = `${key}:${req.ip}`, now = Date.now();
  const arr = (hits.get(k) || []).filter(t => now - t < windowMs);
  arr.push(now); hits.set(k, arr);
  return arr.length > max;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.some(t => now - t < 3600e3)) hits.delete(k); }, 600e3).unref();
const samePhone = (a, b) => { const x = phoneDigits(a), y = phoneDigits(b); return x.length >= 7 && y.length >= 7 && x.slice(-7) === y.slice(-7); };
const publicView = a => ({ ref: a.ref, serviceName: a.serviceName, dentist: a.dentist, date: a.date, time: a.time, end: a.end, status: a.status, newPatient: a.newPatient });
const background = p => p.catch(e => console.error("[background]", e));

/* ---------- live updates (server-sent events) ---------- */
const listeners = new Set();
function broadcast(type, data) { const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`; for (const l of listeners) if (type === "slots" || l.admin) l.res.write(msg); }
app.get("/api/events", (req, res) => {
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.flushHeaders();
  const l = { res, admin: !!currentStaff(req) };
  listeners.add(l);
  const ping = setInterval(() => res.write(": ping\n\n"), 25000);
  req.on("close", () => { clearInterval(ping); listeners.delete(l); });
});
function changed(appt) { broadcast("slots", { date: appt.date }); broadcast("appointments", { ref: appt.ref }); }

/* ---------- public API ---------- */
app.get("/api/availability", (req, res) => {
  const date = String(req.query.date || "");
  if (!isYmd(date)) return bad(res, "Use date=YYYY-MM-DD");
  res.json({ date, busy: store.busyFor(date) });
});

app.post("/api/bookings", (req, res) => {
  if (limited(req, "book", 8, 3600e3)) return bad(res, "Too many bookings from this connection. Please call the clinic.", 429);
  const b = req.body || {};
  if (b.website) return res.status(201).json({ appt: null });            // honeypot field bots fill in
  const svc = svcById(b.service);
  if (!svc) return bad(res, "Choose a treatment.");
  if (!isYmd(b.date) || !isHm(b.time)) return bad(res, "Choose a day and time.");
  const name = str(b.name, 80), phone = str(b.phone, 30), email = str(b.email, 120);
  if (name.length < 2) return bad(res, "Enter your full name.");
  if (!validPhone(phone)) return bad(res, "Enter a phone number with 7 to 15 digits.");
  if (!validEmail(email)) return bad(res, "Enter a valid email address.");
  const pref = b.dentist === "any" || !b.dentist ? "any" : b.dentist;
  if (pref !== "any" && !svc.docs.includes(pref)) return bad(res, "That dentist doesn't offer this treatment.");
  const start = toMin(b.time);
  if (!slotStarts(clinic, b.date, svc.dur).includes(start)) return bad(res, "That time isn't available for online booking. Please pick another.", 409);

  const candidates = freeDentists(svc, start, store.busyFor(b.date), pref);
  const appt = store.claim({
    ref: newRef(), kind: "appt", source: "online", service: svc.id, serviceName: svc.name,
    date: b.date, time: b.time, end: hm(start + svc.dur), name, phone, email,
    newPatient: !!b.newPatient, dob: isYmd(b.dob) ? b.dob : null, notes: str(b.notes, 600) || null, status: "booked",
  }, runTimes(start, start + svc.dur), candidates);
  if (!appt) return bad(res, "Someone just booked that time. Please pick another.", 409);

  changed(appt);
  res.status(201).json({ appt: publicView(appt) });
  background(Promise.all([notifyClinic("booked", appt), emailPatient("booked", appt)]));
});

// Patients look up / cancel their own bookings with the reference plus their phone number.
app.post("/api/bookings/lookup", (req, res) => {
  if (limited(req, "lookup", 60, 600e3)) return bad(res, "Too many requests.", 429);
  const items = Array.isArray(req.body?.items) ? req.body.items.slice(0, 20) : [];
  res.json({ appts: items.map(i => store.getAppt(str(i.ref, 20))).filter((a, n) => a && a.kind === "appt" && samePhone(a.phone, items[n].phone)).map(publicView) });
});
app.post("/api/bookings/:ref/cancel", (req, res) => {
  if (limited(req, "cancel", 20, 3600e3)) return bad(res, "Too many requests.", 429);
  const a = store.getAppt(str(req.params.ref, 20));
  if (!a || a.kind !== "appt" || !samePhone(a.phone, req.body?.phone)) return bad(res, "Booking not found.", 404);
  if (a.status !== "booked") return bad(res, `This booking is already ${a.status}.`, 409);
  const done = store.cancel(a.ref);
  changed(done);
  res.json({ appt: publicView(done) });
  background(Promise.all([notifyClinic("cancelled", done), emailPatient("cancelled", done)]));
});

app.post("/api/feedback", (req, res) => {
  if (limited(req, "feedback", 5, 3600e3)) return bad(res, "Thanks! We've already received your feedback.", 429);
  const b = req.body || {};
  if (b.website) return res.status(201).json({ ok: true });
  const rating = Number(b.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return bad(res, "Choose a rating from 1 to 5 stars.");
  staff.addFeedback({ rating, comment: str(b.comment, 1000), name: str(b.name, 60), contact: str(b.contact, 120), ref: str(b.ref, 20) });
  broadcast("feedback", {});
  res.status(201).json({ ok: true });
});

app.get("/api/chat/status", (req, res) => res.json({ enabled: chatEnabled }));
app.post("/api/chat", async (req, res) => {
  if (!chatEnabled) return bad(res, "Chat assistant is off.", 503);
  if (limited(req, "chat", 30, 600e3)) return bad(res, "Too many messages. Please wait a few minutes.", 429);
  const raw = Array.isArray(req.body?.messages) ? req.body.messages.slice(-16) : [];
  const history = raw.filter(m => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .map(m => ({ role: m.role, content: m.content.slice(0, 1500) }));
  while (history.length && history[0].role !== "user") history.shift();
  if (!history.length || history.at(-1).role !== "user") return bad(res, "Send a message.");
  try { res.json(await chatReply(history)); }
  catch (e) { console.error("[chat]", e.status || "", e.message); bad(res, "The assistant is unavailable right now.", 502); }
});

/* ---------- staff (admin) ---------- */
const COOKIE = "ar_staff";
const tokenOf = req => { const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(req.headers.cookie || ""); return m ? decodeURIComponent(m[1]) : null; };
const currentStaff = req => staff.staffForToken(tokenOf(req));
const requireAdmin = (req, res, next) => { const s = currentStaff(req); if (!s) return bad(res, "Please sign in.", 401); req.staff = s; next(); };
const cc = clinic.defaultCountryCode;

// First start: create the owner's account from .env so someone can sign in.
if (staff.staffCount() === 0 && process.env.ADMIN_PHONE && process.env.ADMIN_PASSWORD) {
  staff.addStaff({ name: process.env.ADMIN_NAME || "Clinic owner", phone: staff.loginNumber(process.env.ADMIN_PHONE, cc), password: process.env.ADMIN_PASSWORD, createdBy: "setup" });
  console.log("Created the first staff account from ADMIN_PHONE / ADMIN_PASSWORD.");
}

app.post("/api/admin/login", (req, res) => {
  if (limited(req, "login", 10, 900e3)) return bad(res, "Too many attempts. Wait 15 minutes.", 429);
  const phone = staff.loginNumber(req.body?.phone, cc), pw = String(req.body?.password || "");
  if (!staff.staffCount()) return bad(res, "No staff accounts yet. Set ADMIN_PHONE and ADMIN_PASSWORD in .env and restart.", 503);
  const r = phone.length >= 7 && pw ? staff.login(phone, pw) : null;
  if (!r) return bad(res, "Wrong phone number or password.", 401);
  res.set("Set-Cookie", `${COOKIE}=${encodeURIComponent(r.token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${r.maxAge}${req.secure ? "; Secure" : ""}`);
  res.json({ staff: r.staff });
});
app.post("/api/admin/logout", (req, res) => { staff.logout(tokenOf(req)); res.set("Set-Cookie", `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`); res.json({ ok: true }); });
app.get("/api/admin/me", (req, res) => { const s = currentStaff(req); res.json({ staff: s, notify: s ? notifyStatus() : undefined }); });

/* staff accounts: any signed-in staff member can add or remove others */
app.get("/api/admin/staff", requireAdmin, (req, res) => res.json({ staff: staff.listStaff(), me: req.staff.id }));
app.post("/api/admin/staff", requireAdmin, (req, res) => {
  const name = str(req.body?.name, 60), phone = staff.loginNumber(req.body?.phone, cc), pw = String(req.body?.password || "");
  if (name.length < 2) return bad(res, "Enter the staff member's name.");
  if (phone.length < 7 || phone.length > 15) return bad(res, "Enter a phone number with 7 to 15 digits.");
  if (pw.length < staff.MIN_PASSWORD) return bad(res, `The password needs at least ${staff.MIN_PASSWORD} characters.`);
  if (staff.phoneTaken(phone)) return bad(res, "Someone already uses that phone number to sign in.", 409);
  res.status(201).json({ staff: staff.addStaff({ name, phone, password: pw, createdBy: req.staff.name }) });
});
app.delete("/api/admin/staff/:id", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (id === req.staff.id) return bad(res, "You can't remove your own account. Ask another staff member.");
  try { staff.removeStaff(id); res.json({ ok: true }); } catch (e) { bad(res, e.message, 409); }
});
app.post("/api/admin/password", requireAdmin, (req, res) => {
  const cur = String(req.body?.current || ""), next = String(req.body?.next || "");
  if (!staff.verifyPassword(req.staff.id, cur)) return bad(res, "Your current password is wrong.", 403);
  if (next.length < staff.MIN_PASSWORD) return bad(res, `The new password needs at least ${staff.MIN_PASSWORD} characters.`);
  staff.setPassword(req.staff.id, next);
  staff.logoutOthers(req.staff.id, tokenOf(req));          // sign out any other devices
  res.json({ ok: true });
});

/* feedback */
app.get("/api/admin/feedback", requireAdmin, (req, res) => res.json(staff.listFeedback()));
app.delete("/api/admin/feedback/:id", requireAdmin, (req, res) => { staff.deleteFeedback(Number(req.params.id)); res.json({ ok: true }); });

app.get("/api/admin/appointments", requireAdmin, (req, res) => {
  const from = isYmd(req.query.from) ? req.query.from : undefined, to = isYmd(req.query.to) ? req.query.to : undefined;
  res.json({ appts: store.listAppointments({ from, to }) });
});

app.post("/api/admin/appointments", requireAdmin, (req, res) => {
  const b = req.body || {};
  const svc = svcById(b.service);
  if (!svc) return bad(res, "Choose a treatment.");
  if (!isYmd(b.date) || !isHm(b.time)) return bad(res, "Choose a date and time.");
  const name = str(b.name, 80), phone = str(b.phone, 30), email = str(b.email, 120);
  if (name.length < 2) return bad(res, "Enter the patient's name.");
  if (!validPhone(phone)) return bad(res, "Enter a phone number with 7 to 15 digits.");
  if (email && !validEmail(email)) return bad(res, "That email doesn't look right.");
  const start = toMin(b.time), times = runTimes(start, start + svc.dur);
  if (start + svc.dur > 24 * 60) return bad(res, "That runs past midnight.");
  const pool = !b.dentist || b.dentist === "any" ? svc.docs : svc.docs.filter(d => d === b.dentist);
  if (!pool.length) return bad(res, "That dentist doesn't offer this treatment.");
  const appt = store.claim({
    ref: newRef(), kind: "appt", source: ["phone", "walk-in", "other"].includes(b.source) ? b.source : "phone",
    service: svc.id, serviceName: svc.name, date: b.date, time: b.time, end: hm(start + svc.dur),
    name, phone, email: email || null, newPatient: !!b.newPatient, dob: null, notes: str(b.notes, 600) || null, status: "booked",
  }, times, pool);
  if (!appt) {
    const c = store.clashes(b.date, pool[0], times)[0];
    return bad(res, pool.length > 1 ? `No dentist who does ${svc.name.toLowerCase()} is free at ${b.time}.` : `${docById(pool[0]).name} is already booked then${c ? ` (${c.kind === "block" ? "blocked: " + c.name : c.name}, ${c.time}–${c.end})` : ""}.`, 409);
  }
  changed(appt);
  res.status(201).json({ appt });
  if (NOTIFY_STAFF) background(notifyClinic("booked", appt));
  if (appt.email) background(emailPatient("booked", appt));
});

app.post("/api/admin/blocks", requireAdmin, (req, res) => {
  const b = req.body || {};
  if (!isYmd(b.date) || !isHm(b.from) || !isHm(b.to)) return bad(res, "Choose a date and times.");
  const from = toMin(b.from), to = toMin(b.to);
  if (to <= from) return bad(res, "“Until” must be later than “From”.");
  const docs = b.dentist === "all" ? clinic.dentists.map(d => d.id) : [b.dentist].filter(docById);
  if (!docs.length) return bad(res, "Choose a dentist.");
  const times = runTimes(from, to), reason = str(b.reason, 80) || "Unavailable";
  const clash = docs.flatMap(d => store.clashes(b.date, d, times));
  if (clash.length) return bad(res, "Already booked in that time: " + clash.map(a => `${a.kind === "block" ? `block (${a.name})` : a.name} ${a.time}–${a.end} with ${docById(a.dentist)?.name}`).join("; ") + ". Move or cancel these first.", 409);
  const made = [];
  for (const d of docs) {
    const a = store.claim({ ref: newRef("BL"), kind: "block", source: "staff", service: null, serviceName: "Blocked time", date: b.date, time: hm(from), end: hm(to), name: reason, phone: null, email: null, newPatient: false, dob: null, notes: null, status: "blocked" }, times, [d]);
    if (!a) return bad(res, `${docById(d).name}'s time was booked a moment ago. Refresh and try again.`, 409);
    made.push(a); changed(a);
  }
  res.status(201).json({ blocks: made });
});

app.post("/api/admin/appointments/:ref/status", requireAdmin, (req, res) => {
  const a = store.getAppt(str(req.params.ref, 20));
  if (!a) return bad(res, "Not found.", 404);
  const status = req.body?.status;
  let out;
  if (status === "cancelled") {
    if (!["booked", "arrived", "blocked"].includes(a.status)) return bad(res, `Already ${a.status}.`, 409);
    out = store.cancel(a.ref);
    if (a.kind === "appt" && req.body?.notifyPatient !== false) background(emailPatient("cancelled", out));
  } else if (status === "arrived" && a.status === "booked") out = store.setStatus(a.ref, "arrived");
  else if (status === "done" && a.status === "arrived") out = store.setStatus(a.ref, "done");
  else return bad(res, "That change isn't allowed.");
  changed(out);
  res.json({ appt: out });
});

app.post("/api/admin/test-notify", requireAdmin, async (req, res) => {
  if (limited(req, "test", 5, 600e3)) return bad(res, "Too many tests. Wait a few minutes.", 429);
  res.json({ results: await sendTest(), status: notifyStatus() });
});

/* ---------- pages ---------- */
app.use("/shared", express.static(path.join(here, "shared"), { maxAge: 0 }));
app.get("/admin", (req, res) => res.sendFile(path.join(here, "public", "admin.html")));
app.use(express.static(path.join(here, "public"), { maxAge: 0, extensions: ["html"] }));
app.use((req, res) => res.status(404).send("Not found"));

app.listen(PORT, () => {
  const n = notifyStatus();
  console.log(`${clinic.name} running on http://localhost:${PORT}  (staff desk: /admin)`);
  console.log(`  timezone ${process.env.TZ}, today ${ymd(new Date())}`);
  console.log(`  alerts: email ${n.email} → ${n.clinicEmails} address(es); WhatsApp ${n.whatsapp} → ${n.clinicWhatsapp} number(s)`);
  console.log(`  chat assistant: ${chatEnabled ? "on" : "off (set ANTHROPIC_API_KEY to turn on)"}`);
  if (!staff.staffCount()) console.log("  ⚠ No staff accounts yet. Set ADMIN_PHONE and ADMIN_PASSWORD in .env and restart.");
});
