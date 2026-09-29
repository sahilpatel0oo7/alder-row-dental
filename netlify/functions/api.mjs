// Every /api/* request is handled here (Netlify Function).
process.env.TZ = process.env.CLINIC_TZ || "Asia/Kolkata";   // all dates/times are clinic-local

import crypto from "node:crypto";
import clinic from "../../public/shared/clinic.config.js";
import { runTimes, slotStarts, freeDentists, toMin, hm, isYmd, isHm, phoneDigits, validPhone, validEmail } from "../../public/shared/schedule.js";
import * as db from "../../lib/store.js";
import { notifyClinic, emailPatient, sendTest, notifyStatus } from "../../lib/notify.js";
import { chatEnabled, chatReply } from "../../lib/chat.js";

export const config = { path: "/api/*" };

const COOKIE = "ar_staff";
const NOTIFY_STAFF = () => process.env.NOTIFY_ON_STAFF_BOOKINGS === "true";
const cc = clinic.defaultCountryCode;
const svcById = id => clinic.services.find(s => s.id === id);
const docById = id => clinic.dentists.find(d => d.id === id);
const str = (v, max) => String(v ?? "").trim().slice(0, max);
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers } });
const bad = (msg, status = 400) => json({ error: msg }, status);
const samePhone = (a, b) => { const x = phoneDigits(a), y = phoneDigits(b); return x.length >= 7 && y.length >= 7 && x.slice(-7) === y.slice(-7); };
const publicView = a => ({ ref: a.ref, serviceName: a.serviceName, dentist: a.dentist, date: a.date, time: a.time, end: a.end, status: a.status, newPatient: a.newPatient });

async function newRef(prefix = "AR") {
  const a = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  for (;;) { let r = prefix + "-"; for (let i = 0; i < 6; i++) r += a[crypto.randomInt(a.length)]; if (!(await db.refExists(r))) return r; }
}
// Best-effort limiter per function instance (logins use a shared limiter in the store).
const hits = new Map();
function limited(ip, key, max, windowMs) {
  const k = `${key}:${ip}`, t = Date.now();
  const arr = (hits.get(k) || []).filter(x => t - x < windowMs);
  arr.push(t); hits.set(k, arr);
  return arr.length > max;
}
const tokenOf = req => { const m = /(?:^|;\s*)ar_staff=([^;]+)/.exec(req.headers.get("cookie") || ""); return m ? decodeURIComponent(m[1]) : null; };

let seeded = false;
async function seedOwner() {
  if (seeded) return; seeded = true;
  if (process.env.ADMIN_PHONE && process.env.ADMIN_PASSWORD && (await db.staffCount()) === 0) {
    await db.addStaff({ name: process.env.ADMIN_NAME || "Clinic owner", phone: db.loginNumber(process.env.ADMIN_PHONE, cc), password: process.env.ADMIN_PASSWORD, createdBy: "setup" });
  }
}

/* ---------- routes ---------- */
const routes = [];
const route = (method, pattern, handler, opts = {}) => {
  const keys = [];
  const re = new RegExp("^" + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return "([^/]+)"; }) + "$");
  routes.push({ method, re, keys, handler, admin: opts.admin });
};

route("GET", "/api/availability", async ({ url }) => {
  const date = url.searchParams.get("date") || "";
  if (!isYmd(date)) return bad("Use date=YYYY-MM-DD");
  return json({ date, busy: await db.busyFor(date) });
});

route("POST", "/api/bookings", async ({ body: b, ip, ctx }) => {
  if (limited(ip, "book", 8, 3600e3)) return bad("Too many bookings from this connection. Please call the clinic.", 429);
  if (b.website) return json({ appt: null }, 201);
  const svc = svcById(b.service);
  if (!svc) return bad("Choose a treatment.");
  if (!isYmd(b.date) || !isHm(b.time)) return bad("Choose a day and time.");
  const name = str(b.name, 80), phone = str(b.phone, 30), email = str(b.email, 120);
  if (name.length < 2) return bad("Enter your full name.");
  if (!validPhone(phone)) return bad("Enter a phone number with 7 to 15 digits.");
  if (!validEmail(email)) return bad("Enter a valid email address.");
  const pref = !b.dentist || b.dentist === "any" ? "any" : b.dentist;
  if (pref !== "any" && !svc.docs.includes(pref)) return bad("That dentist doesn't offer this treatment.");
  const start = toMin(b.time);
  if (!slotStarts(clinic, b.date, svc.dur).includes(start)) return bad("That time isn't available for online booking. Please pick another.", 409);
  const candidates = freeDentists(svc, start, await db.busyFor(b.date), pref);
  const appt = await db.claim({
    ref: await newRef(), kind: "appt", source: "online", service: svc.id, serviceName: svc.name,
    date: b.date, time: b.time, end: hm(start + svc.dur), name, phone, email,
    newPatient: !!b.newPatient, dob: isYmd(b.dob) ? b.dob : null, notes: str(b.notes, 600) || null, status: "booked",
  }, runTimes(start, start + svc.dur), candidates);
  if (!appt) return bad("Someone just booked that time. Please pick another.", 409);
  ctx.waitUntil(Promise.all([notifyClinic("booked", appt), emailPatient("booked", appt)]).catch(e => console.error(e)));
  return json({ appt: publicView(appt) }, 201);
});

route("POST", "/api/bookings/lookup", async ({ body }) => {
  const items = Array.isArray(body.items) ? body.items.slice(0, 20) : [];
  const found = await Promise.all(items.map(async i => { const a = await db.getAppt(str(i.ref, 20)); return a && a.kind === "appt" && samePhone(a.phone, i.phone) ? publicView(a) : null; }));
  return json({ appts: found.filter(Boolean) });
});

route("POST", "/api/bookings/:ref/cancel", async ({ params, body, ip, ctx }) => {
  if (limited(ip, "cancel", 20, 3600e3)) return bad("Too many requests.", 429);
  const a = await db.getAppt(str(params.ref, 20));
  if (!a || a.kind !== "appt" || !samePhone(a.phone, body.phone)) return bad("Booking not found.", 404);
  if (a.status !== "booked") return bad(`This booking is already ${a.status}.`, 409);
  const done = await db.cancel(a.ref);
  ctx.waitUntil(Promise.all([notifyClinic("cancelled", done), emailPatient("cancelled", done)]).catch(e => console.error(e)));
  return json({ appt: publicView(done) });
});

route("POST", "/api/feedback", async ({ body: b, ip }) => {
  if (limited(ip, "feedback", 5, 3600e3)) return bad("Thanks! We've already received your feedback.", 429);
  if (b.website) return json({ ok: true }, 201);
  const rating = Number(b.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return bad("Choose a rating from 1 to 5 stars.");
  await db.addFeedback({ rating, comment: str(b.comment, 1000) || null, name: str(b.name, 60) || null, contact: str(b.contact, 120) || null, ref: str(b.ref, 20) || null });
  return json({ ok: true }, 201);
});

route("GET", "/api/chat/status", async () => json({ enabled: chatEnabled }));
route("POST", "/api/chat", async ({ body, ip }) => {
  if (!chatEnabled) return bad("Chat assistant is off.", 503);
  if (limited(ip, "chat", 30, 600e3)) return bad("Too many messages. Please wait a few minutes.", 429);
  const raw = Array.isArray(body.messages) ? body.messages.slice(-16) : [];
  const history = raw.filter(m => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim()).map(m => ({ role: m.role, content: m.content.slice(0, 1500) }));
  while (history.length && history[0].role !== "user") history.shift();
  if (!history.length || history.at(-1).role !== "user") return bad("Send a message.");
  try { return json(await chatReply(history)); }
  catch (e) { console.error("[chat]", e.status || "", e.message); return bad("The assistant is unavailable right now.", 502); }
});

/* ---------- staff ---------- */
route("POST", "/api/admin/login", async ({ body, ip, secure }) => {
  if (await db.tooManyLogins(ip)) return bad("Too many attempts. Wait 15 minutes.", 429);
  if (!(await db.staffCount())) return bad("No staff accounts yet. Set ADMIN_PHONE and ADMIN_PASSWORD in Netlify's environment variables, then redeploy.", 503);
  const phone = db.loginNumber(body.phone, cc), pw = String(body.password || "");
  const r = phone.length >= 7 && pw ? await db.login(phone, pw) : null;
  if (!r) return bad("Wrong phone number or password.", 401);
  return json({ staff: r.staff }, 200, { "Set-Cookie": `${COOKIE}=${encodeURIComponent(r.token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${r.maxAge}${secure ? "; Secure" : ""}` });
});
route("POST", "/api/admin/logout", async ({ req }) => { await db.logout(tokenOf(req)); return json({ ok: true }, 200, { "Set-Cookie": `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` }); });
route("GET", "/api/admin/me", async ({ staff }) => json({ staff, notify: staff ? notifyStatus() : undefined }));

route("GET", "/api/admin/appointments", async () => json({ appts: await db.listAppointments() }), { admin: true });

route("POST", "/api/admin/appointments", async ({ body: b, ctx }) => {
  const svc = svcById(b.service);
  if (!svc) return bad("Choose a treatment.");
  if (!isYmd(b.date) || !isHm(b.time)) return bad("Choose a date and time.");
  const name = str(b.name, 80), phone = str(b.phone, 30), email = str(b.email, 120);
  if (name.length < 2) return bad("Enter the patient's name.");
  if (!validPhone(phone)) return bad("Enter a phone number with 7 to 15 digits.");
  if (email && !validEmail(email)) return bad("That email doesn't look right.");
  const start = toMin(b.time), times = runTimes(start, start + svc.dur);
  if (start + svc.dur > 24 * 60) return bad("That runs past midnight.");
  const pool = !b.dentist || b.dentist === "any" ? svc.docs : svc.docs.filter(d => d === b.dentist);
  if (!pool.length) return bad("That dentist doesn't offer this treatment.");
  const appt = await db.claim({
    ref: await newRef(), kind: "appt", source: ["phone", "walk-in", "other"].includes(b.source) ? b.source : "phone",
    service: svc.id, serviceName: svc.name, date: b.date, time: b.time, end: hm(start + svc.dur),
    name, phone, email: email || null, newPatient: !!b.newPatient, dob: null, notes: str(b.notes, 600) || null, status: "booked",
  }, times, pool);
  if (!appt) {
    const c = (await db.clashes(b.date, pool[0], times))[0];
    return bad(pool.length > 1 ? `No dentist who does ${svc.name.toLowerCase()} is free at ${b.time}.` : `${docById(pool[0]).name} is already booked then${c ? ` (${c.kind === "block" ? "blocked: " + c.name : c.name}, ${c.time}–${c.end})` : ""}.`, 409);
  }
  const jobs = [];
  if (NOTIFY_STAFF()) jobs.push(notifyClinic("booked", appt));
  if (appt.email) jobs.push(emailPatient("booked", appt));
  if (jobs.length) ctx.waitUntil(Promise.all(jobs).catch(e => console.error(e)));
  return json({ appt }, 201);
}, { admin: true });

route("POST", "/api/admin/blocks", async ({ body: b }) => {
  if (!isYmd(b.date) || !isHm(b.from) || !isHm(b.to)) return bad("Choose a date and times.");
  const from = toMin(b.from), to = toMin(b.to);
  if (to <= from) return bad("“Until” must be later than “From”.");
  const docs = b.dentist === "all" ? clinic.dentists.map(d => d.id) : [b.dentist].filter(docById);
  if (!docs.length) return bad("Choose a dentist.");
  const times = runTimes(from, to), reason = str(b.reason, 80) || "Unavailable";
  const clash = (await Promise.all(docs.map(d => db.clashes(b.date, d, times)))).flat();
  if (clash.length) return bad("Already booked in that time: " + clash.map(a => `${a.kind === "block" ? `block (${a.name})` : a.name} ${a.time}–${a.end} with ${docById(a.dentist)?.name}`).join("; ") + ". Move or cancel these first.", 409);
  const made = [];
  for (const d of docs) {
    const a = await db.claim({ ref: await newRef("BL"), kind: "block", source: "staff", service: null, serviceName: "Blocked time", date: b.date, time: hm(from), end: hm(to), name: reason, phone: null, email: null, newPatient: false, dob: null, notes: null, status: "blocked" }, times, [d]);
    if (!a) return bad(`${docById(d).name}'s time was booked a moment ago. Refresh and try again.`, 409);
    made.push(a);
  }
  return json({ blocks: made }, 201);
}, { admin: true });

route("POST", "/api/admin/appointments/:ref/status", async ({ params, body, ctx }) => {
  const a = await db.getAppt(str(params.ref, 20));
  if (!a) return bad("Not found.", 404);
  let out;
  if (body.status === "cancelled") {
    if (!["booked", "arrived", "blocked"].includes(a.status)) return bad(`Already ${a.status}.`, 409);
    out = await db.cancel(a.ref);
    if (a.kind === "appt" && body.notifyPatient !== false) ctx.waitUntil(emailPatient("cancelled", out).catch(e => console.error(e)));
  } else if (body.status === "arrived" && a.status === "booked") out = await db.setStatus(a.ref, "arrived");
  else if (body.status === "done" && a.status === "arrived") out = await db.setStatus(a.ref, "done");
  else return bad("That change isn't allowed.");
  return json({ appt: out });
}, { admin: true });

route("POST", "/api/admin/test-notify", async ({ ip }) => {
  if (limited(ip, "test", 5, 600e3)) return bad("Too many tests. Wait a few minutes.", 429);
  return json({ results: await sendTest(), status: notifyStatus() });
}, { admin: true });

route("GET", "/api/admin/staff", async ({ staff }) => json({ staff: await db.listStaff(), me: staff.id }), { admin: true });
route("POST", "/api/admin/staff", async ({ body, staff }) => {
  const name = str(body.name, 60), phone = db.loginNumber(body.phone, cc), pw = String(body.password || "");
  if (name.length < 2) return bad("Enter the staff member's name.");
  if (phone.length < 7 || phone.length > 15) return bad("Enter a phone number with 7 to 15 digits.");
  if (pw.length < db.MIN_PASSWORD) return bad(`The password needs at least ${db.MIN_PASSWORD} characters.`);
  const added = await db.addStaff({ name, phone, password: pw, createdBy: staff.name });
  return added ? json({ staff: added }, 201) : bad("Someone already uses that phone number to sign in.", 409);
}, { admin: true });
route("DELETE", "/api/admin/staff/:id", async ({ params, staff }) => {
  if (params.id === staff.id) return bad("You can't remove your own account. Ask another staff member.");
  try { await db.removeStaff(params.id); return json({ ok: true }); } catch (e) { return bad(e.message, 409); }
}, { admin: true });
route("POST", "/api/admin/password", async ({ body, staff, req }) => {
  if (!(await db.verifyPassword(staff.id, String(body.current || "")))) return bad("Your current password is wrong.", 403);
  const next = String(body.next || "");
  if (next.length < db.MIN_PASSWORD) return bad(`The new password needs at least ${db.MIN_PASSWORD} characters.`);
  await db.setPassword(staff.id, next);
  await db.logoutOthers(staff.id, tokenOf(req));
  return json({ ok: true });
}, { admin: true });

route("GET", "/api/admin/feedback", async () => json(await db.listFeedback()), { admin: true });
route("DELETE", "/api/admin/feedback/:id", async ({ params }) => { await db.deleteFeedback(params.id); return json({ ok: true }); }, { admin: true });

/* ---------- entry point ---------- */
export default async (req, context) => {
  const url = new URL(req.url);
  try {
    await seedOwner();
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.re.exec(url.pathname);
      if (!m) continue;
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      let body = {};
      if (req.method === "POST") {
        const text = await req.text();
        if (text.length > 32 * 1024) return bad("Request too large.", 413);
        try { body = text ? JSON.parse(text) : {}; } catch { return bad("Invalid request."); }
        if (!body || typeof body !== "object") body = {};
      }
      const staff = url.pathname.startsWith("/api/admin/") ? await db.staffForToken(tokenOf(req)) : null;
      if (r.admin && !staff) return bad("Please sign in.", 401);
      return await r.handler({ req, url, params, body, staff, ip: context.ip || "unknown", ctx: context, secure: url.protocol === "https:" });
    }
    return bad("Not found.", 404);
  } catch (e) {
    console.error("[api]", e);
    return bad("Something went wrong on our side. Please try again.", 500);
  }
};
