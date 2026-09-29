import CLINIC from "/shared/clinic.config.js";
import { ymd, parseYmd, hm, runTimes, phoneDigits, validPhone } from "/shared/schedule.js";

const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const docName = id => CLINIC.dentists.find(d => d.id === id)?.name ?? id;
const niceDate = s => parseYmd(s).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
async function api(url, body) {
  const res = await fetch(url, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { showLogin(); throw new Error(data.error || "Please sign in."); }
  if (!res.ok) throw new Error(data.error || "Something went wrong. Try again.");
  return data;
}
function waNumber(p) { let d = phoneDigits(p).replace(/^0+/, ""); return d.length === 10 ? CLINIC.defaultCountryCode + d : d; }

/* ---------- sign in ---------- */
function showLogin() { $("#loginForm").hidden = false; $("#desk").hidden = true; $("#logoutBtn").hidden = true; $("#who").textContent = ""; $("#loginPhone").focus(); }
$("#loginForm").onsubmit = async e => {
  e.preventDefault(); $("#loginErr").hidden = true;
  try { await api("/api/admin/login", { phone: $("#loginPhone").value, password: $("#pw").value }); $("#pw").value = ""; start(); }
  catch (err) { $("#loginErr").textContent = err.message; $("#loginErr").hidden = false; }
};
$("#logoutBtn").onclick = async () => { await api("/api/admin/logout", {}).catch(() => {}); location.reload(); };

/* ---------- desk ---------- */
let rows = [];
async function load() { rows = (await api("/api/admin/appointments")).appts; render(); }

function renderAlerts(n) {
  const cls = v => (String(v).startsWith("off") ? "off" : "on");
  $("#alerts").innerHTML = `<span>Booking alerts:</span>
    <span>WhatsApp <span class="${cls(n.whatsapp)}">${esc(n.whatsapp)}</span> (${n.clinicWhatsapp} number${n.clinicWhatsapp === 1 ? "" : "s"})</span>
    <span>Email <span class="${cls(n.email)}">${esc(n.email)}</span> (${n.clinicEmails} address${n.clinicEmails === 1 ? "" : "es"})</span>
    <button class="btn btn-ghost" id="testBtn" type="button" style="padding:.4em 1em">Send test alert</button><span id="testOut"></span>`;
  $("#testBtn").onclick = async () => {
    const b = $("#testBtn"); b.disabled = true; $("#testOut").textContent = "Sending…";
    try {
      const { results } = await api("/api/admin/test-notify", {});
      $("#testOut").innerHTML = results.length ? results.map(r => `<span class="nt ${r.status}">${esc(r.channel)} ${esc(r.target)}: ${r.status === "sent" ? "sent" : esc(r.error)}</span>`).join(" ") : "Nothing to send to. Add NOTIFY_WHATSAPP / NOTIFY_EMAILS in .env.";
    } catch (e) { $("#testOut").textContent = e.message; }
    b.disabled = false;
  };
}

function render() {
  const f = $("#deskFilter").value, today = ymd(new Date());
  let list = rows;
  if (f === "today") list = list.filter(a => a.date === today);
  if (f === "upcoming") list = list.filter(a => a.date >= today && a.status !== "cancelled");
  const appts = rows.filter(a => a.kind !== "block"), up = appts.filter(a => a.date >= today && a.status === "booked");
  $("#deskStats").innerHTML = `<div><b class="mono">${appts.filter(a => a.date === today && a.status !== "cancelled").length}</b><span>Today</span></div><div><b class="mono">${up.length}</b><span>Upcoming</span></div><div><b class="mono">${up.filter(a => a.newPatient).length}</b><span>New patients upcoming</span></div><div><b class="mono">${up.filter(a => a.source !== "online").length}</b><span>Phone / walk-in upcoming</span></div>`;
  $("#deskBody").innerHTML = list.length ? list.map(a => a.kind === "block" ? `<tr class="is-block">
      <td class="mono">${esc(niceDate(a.date))}<br>${a.time}–${a.end}</td>
      <td><b>${esc(a.name)}</b><br><span class="src">Blocked time</span></td><td>—</td><td>${esc(docName(a.dentist))}</td><td>—</td>
      <td><span class="pill ${a.status === "cancelled" ? "cancelled" : "blocked"}">${a.status === "cancelled" ? "removed" : "blocked"}</span></td>
      <td><div class="act">${a.status === "blocked" ? `<button data-st="cancelled" data-ref="${esc(a.ref)}">Remove block</button>` : ""}</div></td></tr>` : `<tr>
      <td class="mono">${esc(niceDate(a.date))}<br>${a.time}–${a.end}</td>
      <td><b>${esc(a.name)}</b>${a.newPatient ? ' <span class="tag">New</span>' : ""}<br><span class="mono">${esc(a.phone)}</span>${a.email ? "<br>" + esc(a.email) : ""}<br><span class="src">${esc(a.source)}</span></td>
      <td>${esc(a.serviceName)}</td><td>${esc(docName(a.dentist))}</td>
      <td style="max-width:220px">${esc(a.notes || "—")}</td>
      <td><span class="pill ${a.status}">${a.status}</span><br><small class="mono" style="color:var(--muted)">${esc(a.ref)}</small><br>${a.notifications.map(n => `<span class="nt ${n.status}" title="${esc(n.error || n.created_at)}">${n.channel === "whatsapp" ? "WA" : "✉"} ${esc(n.event.replace("patient-", "patient "))} ${n.status === "sent" ? "✓" : "✗"}</span>`).join("")}</td>
      <td><div class="act">${a.status === "booked" ? `<button data-st="arrived" data-ref="${esc(a.ref)}">Arrived</button>` : ""}${a.status === "arrived" ? `<button data-st="done" data-ref="${esc(a.ref)}">Done</button>` : ""}${a.status === "booked" || a.status === "arrived" ? `<button data-st="cancelled" data-ref="${esc(a.ref)}">Cancel</button>` : ""}</div>
        ${a.phone ? `<div class="act" style="margin-top:6px"><a class="walink" target="_blank" rel="noopener" href="https://wa.me/${waNumber(a.phone)}?text=${encodeURIComponent(`Hello ${a.name}, this is ${CLINIC.name}. Your ${a.serviceName} appointment (ref ${a.ref}) is on ${niceDate(a.date)} at ${a.time}. Please arrive 10 minutes early. Reply here if you need to change it.`)}">WhatsApp patient</a></div>` : ""}</td></tr>`).join("")
    : `<tr><td colspan="7" class="empty">No appointments here yet. Online, phone and walk-in bookings appear in this table as they happen.</td></tr>`;
}
$("#deskFilter").onchange = render;
$("#deskBody").addEventListener("click", async e => {
  const b = e.target.closest("[data-st]"); if (!b) return;
  if (b.dataset.st === "cancelled" && b.dataset.sure !== "1") { b.dataset.sure = "1"; b.textContent = "Tap again to confirm"; setTimeout(() => { if (b.isConnected) { b.dataset.sure = "0"; b.textContent = b.closest("tr").classList.contains("is-block") ? "Remove block" : "Cancel"; } }, 4000); return; }
  b.disabled = true;
  try { await api(`/api/admin/appointments/${encodeURIComponent(b.dataset.ref)}/status`, { status: b.dataset.st }); await load(); }
  catch (err) { b.disabled = false; b.textContent = "Retry"; b.title = err.message; }
});

function setupForms() {
  const opt = (v, t, sel) => `<option value="${esc(v)}" ${sel ? "selected" : ""}>${esc(t)}</option>`;
  const dayTimes = runTimes(7 * 60, 21 * 60);
  $("#oSvc").innerHTML = CLINIC.services.map(s => opt(s.id, `${s.name} (${s.dur} min)`)).join("");
  const fillDocs = () => { const svc = CLINIC.services.find(s => s.id === $("#oSvc").value); $("#oDoc").innerHTML = opt("any", "First available") + CLINIC.dentists.filter(d => svc.docs.includes(d.id)).map(d => opt(d.id, d.name)).join(""); };
  $("#oSvc").onchange = fillDocs; fillDocs();
  $("#bDoc").innerHTML = opt("all", "All dentists (clinic closed)") + CLINIC.dentists.map(d => opt(d.id, d.name)).join("");
  $("#oTime").innerHTML = dayTimes.map(t => opt(t, t, t === "09:00")).join("");
  $("#bFrom").innerHTML = dayTimes.map(t => opt(t, t, t === "08:30")).join("");
  $("#bTo").innerHTML = runTimes(7 * 60 + 30, 21 * 60 + 30).map(t => opt(t, t, t === "18:00")).join("");
  $("#oDate").value = $("#bDate").value = ymd(new Date());
  const show = (errEl, okEl, err, ok) => { $(errEl).hidden = !err; $(errEl).textContent = err || ""; $(okEl).hidden = !ok; $(okEl).textContent = ok || ""; };

  $("#offForm").onsubmit = async e => {
    e.preventDefault(); show("#oErr", "#oOk");
    const name = $("#oName").value.trim(), phone = $("#oPhone").value.trim();
    if (name.length < 2) return show("#oErr", "#oOk", "Enter the patient's name.");
    if (!validPhone(phone)) return show("#oErr", "#oOk", "Enter a phone number with 7 to 15 digits.");
    const btn = e.submitter; btn.disabled = true;
    try {
      const { appt } = await api("/api/admin/appointments", { service: $("#oSvc").value, dentist: $("#oDoc").value, date: $("#oDate").value, time: $("#oTime").value, name, phone, email: $("#oEmail").value.trim(), source: $("#oSrc").value, notes: $("#oNotes").value.trim() });
      ["#oName", "#oPhone", "#oEmail", "#oNotes"].forEach(s => $(s).value = "");
      show("#oErr", "#oOk", "", `Added ${appt.ref}: ${appt.name}, ${niceDate(appt.date)} at ${appt.time} with ${docName(appt.dentist)}. That time is now taken online.`);
      await load();
    } catch (err) { show("#oErr", "#oOk", err.message); }
    btn.disabled = false;
  };
  $("#blkForm").onsubmit = async e => {
    e.preventDefault(); show("#bErr", "#bOk");
    const btn = e.submitter; btn.disabled = true;
    try {
      const { blocks } = await api("/api/admin/blocks", { dentist: $("#bDoc").value, date: $("#bDate").value, from: $("#bFrom").value, to: $("#bTo").value, reason: $("#bReason").value.trim() });
      $("#bReason").value = "";
      show("#bErr", "#bOk", "", `Blocked ${niceDate(blocks[0].date)} ${blocks[0].time}–${blocks[0].end} for ${blocks.length > 1 ? "all dentists" : docName(blocks[0].dentist)}.`);
      await load();
    } catch (err) { show("#bErr", "#bOk", err.message); }
    btn.disabled = false;
  };
}

/* ---------- tabs ---------- */
document.querySelectorAll("[data-tab]").forEach(b => b.onclick = () => {
  document.querySelectorAll("[data-tab]").forEach(x => { x.setAttribute("aria-selected", x === b); $("#" + x.dataset.tab).hidden = x !== b; });
  if (b.dataset.tab === "feedback") loadFeedback();
  if (b.dataset.tab === "staffTab") loadStaff();
});

/* ---------- feedback ---------- */
const stars = n => "★".repeat(n) + "☆".repeat(5 - n);
async function loadFeedback() {
  const { items, count, average } = await api("/api/admin/feedback");
  $("#fbCount").textContent = count;
  const dist = [5, 4, 3, 2, 1].map(r => [r, items.filter(i => i.rating === r).length]);
  $("#fbStats").innerHTML = `<div><b class="mono">${count ? average.toFixed(1) : "—"}</b><span>Average of ${count} rating${count === 1 ? "" : "s"}</span></div>` + dist.map(([r, n]) => `<div><b class="mono">${n}</b><span>${r} star${r === 1 ? "" : "s"}</span></div>`).join("");
  $("#fbList").innerHTML = items.length ? items.map(f => `<div class="fb">
    <div class="fb-top"><span class="stars" aria-label="${f.rating} out of 5">${stars(f.rating)}</span><small class="mono">${esc(new Date(f.createdAt).toLocaleString())}</small></div>
    ${f.comment ? `<p>${esc(f.comment)}</p>` : `<p style="color:var(--muted)">No comment</p>`}
    <small>${esc(f.name || "Anonymous")}${f.contact ? " · " + esc(f.contact) : ""}${f.ref ? " · booking " + esc(f.ref) : ""}</small>
    <button type="button" data-delfb="${f.id}">Delete</button></div>`).join("") : `<p class="empty">No feedback yet. It appears here as soon as a patient sends it from the website.</p>`;
}
$("#fbList").addEventListener("click", async e => {
  const b = e.target.closest("[data-delfb]"); if (!b) return;
  if (b.dataset.sure !== "1") { b.dataset.sure = "1"; b.textContent = "Tap again to delete"; return; }
  await fetch(`/api/admin/feedback/${b.dataset.delfb}`, { method: "DELETE" }); loadFeedback();
});

/* ---------- staff accounts ---------- */
let meId = null;
async function loadStaff() {
  const { staff, me } = await api("/api/admin/staff"); meId = me;
  $("#staffBody").innerHTML = staff.map(s => `<tr>
    <td><b>${esc(s.name)}</b>${s.id === me ? ' <span class="you">you</span>' : ""}<br><small style="color:var(--muted)">Added ${s.createdBy ? "by " + esc(s.createdBy) : ""} ${esc(new Date(s.createdAt).toLocaleDateString())}</small></td>
    <td class="mono">+${esc(s.phone)}</td>
    <td><small>${s.lastLogin ? esc(new Date(s.lastLogin).toLocaleString()) : "Never"}</small></td>
    <td>${s.id === me ? "" : `<div class="act"><button type="button" data-rmstaff="${s.id}" data-name="${esc(s.name)}">Remove</button></div>`}</td></tr>`).join("");
}
$("#staffBody").addEventListener("click", async e => {
  const b = e.target.closest("[data-rmstaff]"); if (!b) return;
  if (b.dataset.sure !== "1") { b.dataset.sure = "1"; b.textContent = `Remove ${b.dataset.name}?`; setTimeout(() => { if (b.isConnected) { b.dataset.sure = "0"; b.textContent = "Remove"; } }, 4000); return; }
  b.disabled = true; $("#sListErr").hidden = true;
  const res = await fetch(`/api/admin/staff/${b.dataset.rmstaff}`, { method: "DELETE" });
  if (!res.ok) { $("#sListErr").textContent = (await res.json().catch(() => ({}))).error || "Couldn't remove."; $("#sListErr").hidden = false; }
  loadStaff();
});
$("#addStaffForm").onsubmit = async e => {
  e.preventDefault(); const show = (err, ok) => { $("#sErr").hidden = !err; $("#sErr").textContent = err || ""; $("#sOk").hidden = !ok; $("#sOk").textContent = ok || ""; };
  show();
  const name = $("#sName").value.trim(), phone = $("#sPhone").value.trim(), password = $("#sPw").value;
  if (name.length < 2) return show("Enter their name.");
  if (!validPhone(phone)) return show("Enter a phone number with 7 to 15 digits.");
  if (password.length < 8) return show("The password needs at least 8 characters.");
  const btn = e.submitter; btn.disabled = true;
  try { const { staff } = await api("/api/admin/staff", { name, phone, password }); ["#sName", "#sPhone", "#sPw"].forEach(s => $(s).value = ""); show("", `${staff.name} can now sign in with +${staff.phone}.`); loadStaff(); }
  catch (err) { show(err.message); }
  btn.disabled = false;
};
$("#pwForm").onsubmit = async e => {
  e.preventDefault(); const show = (err, ok) => { $("#pErr").hidden = !err; $("#pErr").textContent = err || ""; $("#pOk").hidden = !ok; $("#pOk").textContent = ok || ""; };
  show();
  if ($("#pwNew").value.length < 8) return show("The new password needs at least 8 characters.");
  const btn = e.submitter; btn.disabled = true;
  try { await api("/api/admin/password", { current: $("#pwCur").value, next: $("#pwNew").value }); $("#pwCur").value = $("#pwNew").value = ""; show("", "Password changed."); }
  catch (err) { show(err.message); }
  btn.disabled = false;
};

let started = false;
async function start() {
  const me = await api("/api/admin/me");
  if (!me.staff) return showLogin();
  $("#loginForm").hidden = true; $("#desk").hidden = false; $("#logoutBtn").hidden = false;
  $("#who").textContent = `Signed in as ${me.staff.name}`;
  renderAlerts(me.notify);
  if (!started) {
    started = true; setupForms();
    // check for new bookings and feedback while the desk is open
    setInterval(() => { if (!document.hidden) load().catch(() => {}); }, 15000);
    setInterval(() => { if (!document.hidden) loadFeedback().catch(() => {}); }, 60000);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) load().catch(() => {}); });
  }
  await load();
  loadFeedback().catch(() => {});
}
start().catch(() => showLogin());
