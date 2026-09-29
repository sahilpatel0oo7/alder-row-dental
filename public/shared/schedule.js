// Scheduling rules shared by the server (authoritative) and the browser (display).
export const DAYNAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export const pad = n => String(n).padStart(2, "0");
export const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const parseYmd = s => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
export const hm = m => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
export const toMin = t => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
export const isYmd = s => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && ymd(parseYmd(s)) === s;
export const isHm = s => typeof s === "string" && /^([01]\d|2[0-3]):(00|30)$/.test(s);
export const runTimes = (from, to) => { const t = []; for (let m = from; m < to; m += 30) t.push(hm(m)); return t; };

/** Online start times (minutes) for a service of `dur` minutes on a date. */
export function slotStarts(clinic, dateStr, dur, now = new Date()) {
  if (!isYmd(dateStr)) return [];
  const blocks = clinic.hours[parseYmd(dateStr).getDay()];
  if (!blocks) return [];
  const today = ymd(now);
  if (dateStr < today) return [];
  const last = new Date(now); last.setDate(last.getDate() + clinic.bookingDaysAhead);
  if (dateStr > ymd(last)) return [];
  const earliest = dateStr === today ? now.getHours() * 60 + now.getMinutes() + clinic.minLeadMinutes : -1;
  const out = [];
  for (const [a, b] of blocks) for (let m = a; m + dur <= b; m += 30) if (m >= earliest) out.push(m);
  return out;
}

/** Dentists (ids) who can do `svc` and are free for its whole length from `startMin`.
 *  busy: { dentistId: ["HH:MM", ...] } */
export function freeDentists(svc, startMin, busy, pref = "any") {
  const need = runTimes(startMin, startMin + svc.dur);
  const pool = pref === "any" ? svc.docs : svc.docs.filter(d => d === pref);
  return pool.filter(doc => need.every(t => !(busy[doc] || []).includes(t)));
}

export function phoneDigits(p) { return String(p || "").replace(/\D/g, ""); }
export function validPhone(p) { const d = phoneDigits(p); return d.length >= 7 && d.length <= 15 && /^[+\d\s().\-\/]+$/.test(String(p).trim()); }
export function validEmail(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || "").trim()); }
