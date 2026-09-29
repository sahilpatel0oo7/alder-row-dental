// Sends booking alerts to the clinic/doctors (WhatsApp + email) and a confirmation email to the patient.
import nodemailer from "nodemailer";
import clinic from "../shared/clinic.config.js";
import { parseYmd } from "../shared/schedule.js";
import { logNotification } from "./db.js";

const list = v => String(v || "").split(",").map(s => s.trim()).filter(Boolean);
const docName = id => clinic.dentists.find(d => d.id === id)?.name ?? id;
const niceDate = s => parseYmd(s).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const smtpPort = Number(process.env.SMTP_PORT || 465);
const mailer = process.env.SMTP_HOST && process.env.SMTP_USER
  ? nodemailer.createTransport({ host: process.env.SMTP_HOST, port: smtpPort, secure: smtpPort === 465, auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } })
  : null;
const FROM = process.env.MAIL_FROM || (process.env.SMTP_USER ? `${clinic.name} <${process.env.SMTP_USER}>` : "");
const WA_PROVIDER = (process.env.WHATSAPP_PROVIDER || "none").toLowerCase();

export function notifyStatus() {
  return {
    email: mailer ? "on" : "off (set SMTP_* in .env)",
    whatsapp: WA_PROVIDER === "none" ? "off (set WHATSAPP_PROVIDER in .env)" : WA_PROVIDER,
    clinicEmails: list(process.env.NOTIFY_EMAILS).length,
    clinicWhatsapp: list(process.env.NOTIFY_WHATSAPP).length,
  };
}

/** Who hears about a booking: the clinic-wide lists plus that dentist's own contacts. */
function recipients(dentist) {
  const key = String(dentist || "").toUpperCase();
  return {
    emails: [...new Set([...list(process.env.NOTIFY_EMAILS), ...list(process.env[`NOTIFY_${key}_EMAIL`])])],
    whatsapp: [...new Set([...list(process.env.NOTIFY_WHATSAPP), ...list(process.env[`NOTIFY_${key}_WHATSAPP`])])],
  };
}

async function sendEmail(to, subject, text, html) {
  if (!mailer) throw new Error("Email is not configured");
  await mailer.sendMail({ from: FROM, to, subject, text, html });
}

/** target: "917489791016" (Twilio) or "917489791016:APIKEY" (CallMeBot). */
async function sendWhatsApp(target, text) {
  const [number, key] = target.split(":");
  if (WA_PROVIDER === "callmebot") {
    if (!key) throw new Error("CallMeBot needs number:apikey");
    const url = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(number)}&text=${encodeURIComponent(text)}&apikey=${encodeURIComponent(key)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    const body = await res.text();
    if (!res.ok || /error|invalid|not\s+allowed/i.test(body.slice(0, 400))) throw new Error(`CallMeBot ${res.status}: ${body.replace(/<[^>]+>/g, " ").trim().slice(0, 200)}`);
    return;
  }
  if (WA_PROVIDER === "twilio") {
    const sid = process.env.TWILIO_ACCOUNT_SID, token = process.env.TWILIO_AUTH_TOKEN;
    const form = new URLSearchParams({ From: `whatsapp:${process.env.TWILIO_WHATSAPP_FROM}`, To: `whatsapp:+${number.replace(/\D/g, "")}`, Body: text });
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: "POST", body: form, signal: AbortSignal.timeout(20000),
      headers: { Authorization: "Basic " + Buffer.from(`${sid}:${token}`).toString("base64") },
    });
    if (!res.ok) throw new Error(`Twilio ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return;
  }
  throw new Error("WhatsApp is not configured");
}

function bookingLines(a) {
  return [
    `Ref: ${a.ref}`, `Treatment: ${a.serviceName}`, `Dentist: ${docName(a.dentist)}`,
    `When: ${niceDate(a.date)}, ${a.time}–${a.end}`, `Patient: ${a.name}`, a.phone ? `Phone: ${a.phone}` : "",
    a.email ? `Email: ${a.email}` : "", a.newPatient ? "New patient: yes" : "", a.dob ? `Date of birth: ${a.dob}` : "",
    a.notes ? `Notes: ${a.notes}` : "", `Booked: ${a.source === "online" ? "online" : a.source}`,
  ].filter(Boolean);
}

async function attempt(ref, event, channel, target, fn) {
  const shown = channel === "whatsapp" ? target.split(":")[0] : target;
  try { await fn(); logNotification({ ref, event, channel, target: shown, status: "sent" }); return { channel, target: shown, status: "sent" }; }
  catch (e) { logNotification({ ref, event, channel, target: shown, status: "failed", error: e.message }); console.error(`[notify] ${channel} to ${shown} failed:`, e.message); return { channel, target: shown, status: "failed", error: e.message }; }
}

/** event: "booked" | "cancelled" */
export async function notifyClinic(event, a) {
  const { emails, whatsapp } = recipients(a.dentist);
  const head = event === "booked" ? "🦷 New booking" : "❌ Booking cancelled";
  const text = [`${head} · ${clinic.name}`, ...bookingLines(a)].join("\n");
  const subject = `${event === "booked" ? "New booking" : "Cancelled"}: ${a.name}, ${a.date} ${a.time} (${a.serviceName})`;
  const html = `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5"><h2 style="margin:0 0 8px">${esc(head)}</h2>${bookingLines(a).map(l => `<div>${esc(l)}</div>`).join("")}</div>`;
  await Promise.all([
    ...(WA_PROVIDER === "none" ? [] : whatsapp.map(t => attempt(a.ref, event, "whatsapp", t, () => sendWhatsApp(t, text)))),
    ...(mailer ? emails.map(e => attempt(a.ref, event, "email", e, () => sendEmail(e, subject, text, html))) : []),
  ]);
}

export async function emailPatient(event, a) {
  if (!mailer || !a.email || process.env.SEND_PATIENT_EMAIL === "false") return;
  const booked = event === "booked";
  const subject = booked ? `Your appointment on ${niceDate(a.date)} at ${a.time}` : `Your appointment ${a.ref} is cancelled`;
  const lines = booked
    ? [`Hello ${a.name},`, "", `Your appointment at ${clinic.name} is booked.`, "", `Reference: ${a.ref}`, `Treatment: ${a.serviceName}`, `Dentist: ${docName(a.dentist)}`, `When: ${niceDate(a.date)}, ${a.time}–${a.end}`, `Where: ${clinic.address.join(", ")}`, "", `Please arrive 10 minutes early${a.newPatient ? " to fill in a short health form" : ""}. To change or cancel, call ${clinic.phone} or message us on WhatsApp at ${clinic.whatsappDisplay}.`]
    : [`Hello ${a.name},`, "", `Your ${a.serviceName} appointment on ${niceDate(a.date)} at ${a.time} (ref ${a.ref}) has been cancelled.`, "", `To book again, visit our website or call ${clinic.phone}.`];
  const html = `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.55">${lines.map(l => l ? `<div>${esc(l)}</div>` : "<br>").join("")}</div>`;
  await attempt(a.ref, `patient-${event}`, "email", a.email, () => sendEmail(a.email, subject, lines.join("\n"), html));
}

export async function sendTest() {
  const { emails, whatsapp } = recipients(null);
  const text = `✅ Test from ${clinic.name}: booking alerts are working.`;
  return Promise.all([
    ...(WA_PROVIDER === "none" ? [] : whatsapp.map(t => attempt(null, "test", "whatsapp", t, () => sendWhatsApp(t, text)))),
    ...(mailer ? emails.map(e => attempt(null, "test", "email", e, () => sendEmail(e, `Test: booking alerts from ${clinic.name}`, text, `<p>${esc(text)}</p>`))) : []),
  ]);
}
