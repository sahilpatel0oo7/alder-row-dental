import CLINIC from "/shared/clinic.config.js";
import { DAYNAMES, ymd, parseYmd, hm, toMin, slotStarts, freeDentists, validPhone, validEmail } from "/shared/schedule.js";

const { services: SERVICES, dentists: DENTISTS, hours: HOURS, currency: CUR } = CLINIC;
const SHADES = [["B1","#F5F0E4"],["A1","#F0E7D3"],["B2","#EEE2C6"],["D2","#E7DCC7"],["A2","#EBDCBF"],["C1","#E4D9C3"],["C2","#DDCEB1"],["D4","#D9C7A7"],["A3","#E4CDA7"],["D3","#DECEB2"],["B3","#E1CAA0"],["A3.5","#DCC097"],["B4","#DAC08F"],["C3","#D4C1A0"],["A4","#D0B287"],["C4","#C7AF89"]];

const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const svcById = id => SERVICES.find(s => s.id === id);
const docById = id => DENTISTS.find(d => d.id === id);
const price = p => p === 0 ? "Free" : `${CUR}${p}`;
const niceDate = s => parseYmd(s).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
async function api(url, body) {
  const res = await fetch(url, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || "Something went wrong. Please try again."), { status: res.status });
  return data;
}

/* ---------- 3D tooth ---------- */
let setToothShade = () => {};
(function tooth() {
  const canvas = $("#tooth");
  if (!window.THREE) { canvas.outerHTML = '<div class="stage-fallback"><svg viewBox="0 0 32 32" width="60%"><path d="M9 4c-4 0-6 3-6 7 0 5 2 7 3 12 .6 3 1.4 5 3 5 2.2 0 2-6 7-6s4.8 6 7 6c1.6 0 2.4-2 3-5 1-5 3-7 3-12 0-4-2-7-6-7-3 0-4 1.5-7 1.5S12 4 9 4z" fill="#EBDCBF"/></svg></div>'; return; }
  const THREE = window.THREE;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputEncoding = THREE.sRGBEncoding;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
  camera.position.set(0, 0.6, 8.2);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x6f9f98, 0.95));
  const key = new THREE.DirectionalLight(0xffffff, 1.05); key.position.set(3, 5, 5); scene.add(key);
  const rim = new THREE.DirectionalLight(0x9fe3d6, 0.9); rim.position.set(-5, 2, -4); scene.add(rim);
  const fill = new THREE.PointLight(0xfff3e0, 0.4); fill.position.set(0, -3, 4); scene.add(fill);
  const mat = new THREE.MeshPhysicalMaterial({ color: 0xEBDCBF, roughness: 0.26, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.12, reflectivity: 0.5 });
  const toothGroup = new THREE.Group();

  // crown: a sphere pushed into four cusps with a central fissure
  const crown = new THREE.SphereGeometry(1, 128, 96);
  const p = crown.attributes.position, v = new THREE.Vector3();
  const cusps = [[.46,.42],[-.46,.42],[.46,-.42],[-.46,-.42]];
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    let { x, y, z } = v; const r = Math.hypot(x, z);
    if (y > 0) {
      let bump = 0; for (const [cx, cz] of cusps) bump += Math.exp(-((x-cx)**2 + (z-cz)**2) / 0.085);
      const fiss = Math.exp(-(x*x)/0.006) * .6 + Math.exp(-(z*z)/0.006) * .4;
      y = y * (0.62 + 0.36 * bump) - y * 0.1 * fiss * (1 - r);
    } else { y = y * 0.72; const k = 0.8 + 0.2 * (1 + v.y); x *= k; z *= k; }
    p.setXYZ(i, x * 1.1, y, z * 0.98);
  }
  crown.computeVertexNormals();
  toothGroup.add(new THREE.Mesh(crown, mat));
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.78, 0.6, 0.5, 64, 1, true), mat);
  neck.position.y = -0.72; toothGroup.add(neck);
  for (const [sx, tilt, len] of [[-0.36, 0.1, 2.0], [0.38, -0.14, 1.85]]) {
    const g = new THREE.CylinderGeometry(0.32, 0.07, len, 48, 24);
    const rp = g.attributes.position;
    for (let i = 0; i < rp.count; i++) { const t = (len/2 - rp.getY(i)) / len; rp.setX(i, rp.getX(i) + Math.sin(t * 2.2) * 0.12 * Math.sign(sx)); }
    g.computeVertexNormals();
    const root = new THREE.Mesh(g, mat); root.position.set(sx, -0.9 - len/2, 0); root.rotation.z = tilt; toothGroup.add(root);
  }
  toothGroup.position.y = 0.8; toothGroup.rotation.x = 0.35;
  scene.add(toothGroup);

  const N = 90, pg = new THREE.BufferGeometry(), pos = new Float32Array(N*3), spd = [];
  for (let i = 0; i < N; i++) { pos[i*3] = (Math.random()-.5)*6; pos[i*3+1] = (Math.random()-.5)*6; pos[i*3+2] = (Math.random()-.5)*3; spd.push(0.004 + Math.random()*0.01); }
  pg.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  scene.add(new THREE.Points(pg, new THREE.PointsMaterial({ color: 0x7fd1c3, size: 0.06, transparent: true, opacity: 0.75 })));

  let dragging = false, lx = 0, ly = 0, vy = reduceMotion ? 0 : 0.006;
  canvas.addEventListener("pointerdown", e => { dragging = true; lx = e.clientX; ly = e.clientY; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener("pointermove", e => { if (!dragging) return; vy = (e.clientX - lx) * 0.004; toothGroup.rotation.y += vy; toothGroup.rotation.x = Math.max(-0.6, Math.min(1.1, toothGroup.rotation.x + (e.clientY - ly) * 0.003)); lx = e.clientX; ly = e.clientY; });
  const up = () => { dragging = false; }; canvas.addEventListener("pointerup", up); canvas.addEventListener("pointercancel", up);
  const resize = () => { const w = canvas.clientWidth; renderer.setSize(w, w, false); camera.aspect = 1; camera.updateProjectionMatrix(); };
  new ResizeObserver(resize).observe(canvas); resize();
  const target = new THREE.Color(0xEBDCBF);
  setToothShade = hex => target.set(hex);
  let t = 0;
  (function loop() {
    t += 0.016;
    if (!dragging) { vy += ((reduceMotion ? 0 : 0.006) - vy) * 0.03; toothGroup.rotation.y += vy; }
    if (!reduceMotion) { toothGroup.position.y = 0.8 + Math.sin(t * 1.2) * 0.08; for (let i = 0; i < N; i++) { pos[i*3+1] += spd[i]; if (pos[i*3+1] > 3) pos[i*3+1] = -3; } pg.attributes.position.needsUpdate = true; }
    mat.color.lerp(target, 0.08);
    renderer.render(scene, camera);
    requestAnimationFrame(loop);
  })();
})();

(function shades() {
  const box = $("#shadeScale");
  SHADES.forEach(([name, hex]) => {
    const b = document.createElement("button"); b.type = "button"; b.style.background = hex; b.title = name; b.setAttribute("aria-label", `Shade ${name}`);
    b.setAttribute("aria-pressed", name === "A2");
    b.onclick = () => { box.querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", x === b)); $("#shadeName").textContent = name; setToothShade(hex); };
    box.appendChild(b);
  });
})();

/* ---------- static sections ---------- */
$("#svcGrid").innerHTML = SERVICES.map(s => `
  <article class="svc" data-tilt>
    <div class="ico"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="${s.icon}"/></svg></div>
    <h3>${esc(s.name)}</h3><p>${esc(s.desc)}</p>
    <div class="meta"><span><b>${price(s.price)}</b>${s.price ? '<span style="color:var(--muted)"> from</span>' : ""} · <span class="mono">${s.dur} min</span></span><button type="button" data-book="${s.id}">Book →</button></div>
  </article>`).join("");
if (!reduceMotion && matchMedia("(hover: hover)").matches) {
  document.querySelectorAll("[data-tilt]").forEach(card => {
    card.addEventListener("mousemove", e => { const r = card.getBoundingClientRect(); const x = (e.clientX - r.left) / r.width - .5, y = (e.clientY - r.top) / r.height - .5; card.style.transform = `rotateY(${x*12}deg) rotateX(${-y*12}deg) translateZ(6px)`; });
    card.addEventListener("mouseleave", () => card.style.transform = "");
  });
}
$("#svcGrid").addEventListener("click", e => { const b = e.target.closest("[data-book]"); if (b) prefill({ service_id: b.dataset.book }); });

$("#team-list").innerHTML = DENTISTS.map(d => {
  const ini = d.name.replace("Dr. ", "").split(" ").map(w => w[0]).join("");
  return `<article class="doc">
    <svg viewBox="0 0 88 88" aria-hidden="true"><rect width="88" height="88" fill="${d.hue}"/><circle cx="44" cy="36" r="16" fill="#ffffff" opacity=".22"/><path d="M14 88c4-18 16-26 30-26s26 8 30 26z" fill="#ffffff" opacity=".22"/><text x="44" y="52" text-anchor="middle" font-family="Bricolage Grotesque, system-ui" font-weight="800" font-size="26" fill="#ffffff">${esc(ini)}</text></svg>
    <div><h3>${esc(d.name)}</h3><p style="color:var(--jade);font-weight:600;font-size:.9rem">${esc(d.role)}</p><p>${esc(d.bio)}</p><div class="tags">${d.tags.map(t => `<span class="tag">${esc(t)}</span>`).join("")}</div></div>
  </article>`;
}).join("");

(function hours() {
  const today = new Date().getDay();
  $("#hours").innerHTML = [1,2,3,4,5,6,0].map(d => { const h = HOURS[d]; const txt = h ? h.map(([a,b]) => `${hm(a)}–${hm(b)}`).join(", ") : "Closed"; return `<div class="${d === today ? "today" : ""}"><span>${DAYNAMES[d]}</span><span class="mono">${txt}</span></div>`; }).join("");
})();
document.querySelectorAll("[data-copy]").forEach(b => b.onclick = () => {
  const el = document.getElementById(b.dataset.copy);
  navigator.clipboard?.writeText(el.textContent).then(() => { b.textContent = "Copied"; setTimeout(() => b.textContent = "Copy", 1400); })
    .catch(() => { const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); });
});

/* ---------- booking ---------- */
const B = { service: "checkup", dentist: "any", date: null, time: null };
let busy = {};

function openDays() { const out = []; const d = new Date(); d.setHours(0,0,0,0); for (let i = 0; i <= CLINIC.bookingDaysAhead; i++) { const x = new Date(d); x.setDate(d.getDate() + i); out.push(x); } return out; }
async function loadBusy() {
  if (!B.date) { busy = {}; renderTimes(); return; }
  const want = B.date;
  try { const r = await api(`/api/availability?date=${want}`); if (want === B.date) { busy = r.busy; renderTimes(); } }
  catch { $("#times").innerHTML = `<p class="empty">Couldn't load times. Check your connection and try again.</p>`; }
}

function renderSvc() { $("#svcChips").innerHTML = SERVICES.map(s => `<button type="button" class="chip" data-svc="${s.id}" aria-pressed="${B.service === s.id}"><span>${esc(s.name)}</span><small>${price(s.price)} · ${s.dur} min</small></button>`).join(""); }
function renderDocs() {
  const svc = svcById(B.service);
  if (B.dentist !== "any" && !svc.docs.includes(B.dentist)) B.dentist = "any";
  $("#docChips").innerHTML = `<button type="button" class="chip" data-doc="any" aria-pressed="${B.dentist === "any"}"><span>First available</span><small>Any dentist</small></button>` +
    DENTISTS.map(d => `<button type="button" class="chip" data-doc="${d.id}" aria-pressed="${B.dentist === d.id}" ${svc.docs.includes(d.id) ? "" : "disabled"}><span>${esc(d.name)}</span><small>${esc(d.role)}</small></button>`).join("");
}
function renderDays() {
  const svc = svcById(B.service), days = openDays();
  if (!B.date || !slotStarts(CLINIC, B.date, svc.dur).length) { const first = days.find(d => slotStarts(CLINIC, ymd(d), svc.dur).length); B.date = first ? ymd(first) : null; }
  $("#days").innerHTML = days.map(d => { const k = ymd(d), open = slotStarts(CLINIC, k, svc.dur).length > 0;
    return `<button type="button" class="day" data-day="${k}" aria-pressed="${B.date === k}" ${open ? "" : "disabled"}><small>${d.toLocaleDateString(undefined,{weekday:"short"})}</small><b>${d.getDate()}</b><small>${d.toLocaleDateString(undefined,{month:"short"})}</small></button>`; }).join("");
}
function renderTimes() {
  const svc = svcById(B.service), box = $("#times");
  if (!B.date) { box.innerHTML = `<p class="empty">No open days in the booking window.</p>`; renderSummary(); return; }
  const starts = slotStarts(CLINIC, B.date, svc.dur);
  const avail = starts.filter(m => freeDentists(svc, m, busy, B.dentist).length);
  if (B.time && !avail.includes(toMin(B.time))) B.time = null;
  box.innerHTML = starts.length ? starts.map(m => { const ok = avail.includes(m); return `<button type="button" class="time" data-time="${hm(m)}" aria-pressed="${B.time === hm(m)}" ${ok ? "" : `disabled aria-label="${hm(m)} booked"`}>${hm(m)}</button>`; }).join("") : `<p class="empty">Closed on this day.</p>`;
  if (starts.length && !avail.length) box.insertAdjacentHTML("beforeend", `<p class="empty" style="grid-column:1/-1">Fully booked. Try another day or dentist.</p>`);
  renderSummary();
}
function renderSummary() {
  if (!$("#sumRows")) return;
  const svc = svcById(B.service);
  const auto = B.time ? docById(freeDentists(svc, toMin(B.time), busy, B.dentist)[0])?.name : null;
  const who = B.dentist === "any" ? (auto ? `${auto} (first available)` : "First available") : docById(B.dentist).name;
  $("#sumRows").innerHTML = [["Treatment", svc.name], ["Dentist", who], ["Date", B.date ? niceDate(B.date) : "—"],
    ["Time", B.time ? `${B.time}–${hm(toMin(B.time) + svc.dur)}` : "Choose a time"], ["Price", price(svc.price) + (svc.price ? " from" : "")]]
    .map(([a, b]) => `<div class="sumrow"><span>${a}</span><span>${esc(b)}</span></div>`).join("");
  $("#st1").classList.add("done"); $("#st2").classList.add("done");
  $("#st3").classList.toggle("done", !!B.date); $("#st4").classList.toggle("done", !!B.time);
  $("#confirmBtn").disabled = !B.time;
}
function renderAll() { renderSvc(); renderDocs(); const prev = B.date; renderDays(); if (B.date !== prev) { busy = {}; } renderTimes(); loadBusy(); }

$("#bookForm").addEventListener("click", e => {
  const s = e.target.closest("[data-svc]"), d = e.target.closest("[data-doc]"), day = e.target.closest("[data-day]"), t = e.target.closest("[data-time]");
  if (s) { B.service = s.dataset.svc; B.time = null; renderAll(); }
  else if (d) { B.dentist = d.dataset.doc; B.time = null; renderDocs(); renderTimes(); }
  else if (day) { B.date = day.dataset.day; B.time = null; busy = {}; renderDays(); renderTimes(); loadBusy(); }
  else if (t) { B.time = t.dataset.time; renderTimes(); }
});
$("#bookForm").addEventListener("submit", e => e.preventDefault());

const summaryShell = $("#sumPanel").innerHTML;
async function confirmBooking() {
  const err = $("#bookErr"); err.hidden = true;
  const name = $("#fName").value.trim(), phone = $("#fPhone").value.trim(), email = $("#fEmail").value.trim();
  const checks = [["#fName", "#eName", name.length >= 2], ["#fPhone", "#ePhone", validPhone(phone)], ["#fEmail", "#eEmail", validEmail(email)]];
  checks.forEach(([f, e, ok]) => { $(e).hidden = ok; $(f).setAttribute("aria-invalid", !ok); });
  if (!B.time) { err.textContent = "Please choose a time above."; err.hidden = false; return; }
  const firstBad = checks.find(c => !c[2]);
  if (firstBad) { err.textContent = "Please fix the highlighted details below."; err.hidden = false; $(firstBad[0]).focus(); return; }
  const btn = $("#confirmBtn"); btn.disabled = true; btn.textContent = "Booking…";
  try {
    const { appt } = await api("/api/bookings", { service: B.service, dentist: B.dentist, date: B.date, time: B.time, name, phone, email,
      newPatient: $("#fNew").value === "yes", dob: $("#fDob").value || null, notes: $("#fNotes").value.trim(), website: $("#fWebsite").value });
    if (!appt) throw new Error("Booking didn't go through. Please call the clinic.");
    const mine = store.get("ar_mine2", []).filter(m => m.ref !== appt.ref); mine.unshift({ ref: appt.ref, phone }); store.set("ar_mine2", mine.slice(0, 20));
    $("#sumPanel").innerHTML = `<div class="confirm"><span class="eyebrow">Booked</span><h3>See you ${esc(niceDate(appt.date))} at ${appt.time}</h3>
      <p>${esc(appt.serviceName)} with ${esc(docById(appt.dentist)?.name)}</p><div class="ref">${esc(appt.ref)}</div>
      <p style="color:var(--muted);font-size:.9rem">We've sent the details to the clinic${email ? " and a confirmation to your email" : ""}. Keep this reference. Arrive 10 minutes early${appt.newPatient ? " to fill in a short health form" : ""}.</p>
      <button class="btn btn-ghost" type="button" id="againBtn">Book another</button></div>`;
    $("#againBtn").onclick = () => { $("#sumPanel").innerHTML = summaryShell; $("#confirmBtn").onclick = confirmBooking; renderTimes(); };
    $("#fNotes").value = "";
    B.time = null; loadBusy(); loadMine();
  } catch (e) {
    err.textContent = e.message; err.hidden = false;
    btn.disabled = false; btn.textContent = "Confirm booking"; loadBusy();
  }
}
$("#confirmBtn").onclick = confirmBooking;

async function loadMine() {
  const items = store.get("ar_mine2", []), panel = $("#minePanel");
  if (!items.length) { panel.hidden = true; return; }
  try {
    const { appts } = await api("/api/bookings/lookup", { items });
    panel.hidden = !appts.length;
    $("#mineList").innerHTML = appts.map(a => `<div class="mine-item"><div><b>${esc(a.serviceName)}</b><br><span class="mono">${esc(niceDate(a.date))} · ${a.time}</span> · <span class="pill ${a.status}">${a.status}</span><br><small class="mono" style="color:var(--muted)">${esc(a.ref)}</small></div>${a.status === "booked" ? `<button type="button" data-cancel="${esc(a.ref)}" data-confirming="0">Cancel</button>` : ""}</div>`).join("");
  } catch { panel.hidden = true; }
}
$("#mineList").addEventListener("click", async e => {
  const b = e.target.closest("[data-cancel]"); if (!b) return;
  if (b.dataset.confirming === "0") { b.dataset.confirming = "1"; b.textContent = "Tap again to cancel"; setTimeout(() => { if (b.isConnected) { b.dataset.confirming = "0"; b.textContent = "Cancel"; } }, 4000); return; }
  b.disabled = true; b.textContent = "Cancelling…";
  const item = store.get("ar_mine2", []).find(m => m.ref === b.dataset.cancel);
  try { await api(`/api/bookings/${encodeURIComponent(b.dataset.cancel)}/cancel`, { phone: item?.phone }); loadMine(); loadBusy(); }
  catch (err) { b.textContent = err.message.length < 40 ? err.message : "Couldn't cancel. Try again"; b.disabled = false; b.dataset.confirming = "0"; }
});

function prefill({ service_id, date, time, dentist_id } = {}) {
  if (service_id && svcById(service_id)) { B.service = service_id; B.dentist = "any"; }
  if (dentist_id && docById(dentist_id)) B.dentist = dentist_id;
  if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) B.date = date;
  B.time = null; renderAll();
  if (time) { B.time = time; loadBusy().then(renderTimes); }
  document.getElementById("book").scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth" });
}

// live updates: refresh times whenever anyone books or cancels that day
try {
  const es = new EventSource("/api/events");
  es.addEventListener("slots", e => { try { if (JSON.parse(e.data).date === B.date) loadBusy(); } catch {} });
} catch {}
document.addEventListener("visibilitychange", () => { if (!document.hidden) loadBusy(); });

renderAll(); loadMine();

/* ---------- feedback ---------- */
const RATE_WORDS = { 1: "Very poor", 2: "Poor", 3: "Okay", 4: "Good", 5: "Excellent" };
$("#fbRate").addEventListener("change", e => { if (e.target.name === "rating") $("#rateWord").textContent = RATE_WORDS[e.target.value]; });
$("#fbForm").onsubmit = async e => {
  e.preventDefault(); const err = $("#fbErr"); err.hidden = true;
  const rating = Number(document.querySelector('input[name="rating"]:checked')?.value || 0);
  if (!rating) { err.textContent = "Choose a star rating first."; err.hidden = false; return; }
  const btn = e.submitter; btn.disabled = true; btn.textContent = "Sending…";
  try {
    await api("/api/feedback", { rating, comment: $("#fbComment").value.trim(), name: $("#fbName").value.trim(), contact: $("#fbContact").value.trim(),
      ref: store.get("ar_mine2", [])[0]?.ref || "", website: $("#fbWebsite").value });
    $("#fbForm").innerHTML = `<div class="fb-thanks"><span class="stars" style="color:#E0A526;font-size:1.6rem">${"★".repeat(rating)}</span><h3>Thank you for your feedback</h3><p style="color:var(--muted)">${rating <= 3 ? "We're sorry it wasn't better. " + ($("#fbContact").value.trim() ? "Someone from the clinic will get back to you." : `If you'd like us to follow up, call ${esc(CLINIC.phone)}.`) : "It means a lot to our team."}</p></div>`;
  } catch (x) { err.textContent = x.message; err.hidden = false; btn.disabled = false; btn.textContent = "Send feedback"; }
};

/* ---------- call / WhatsApp / email ---------- */
(function contactLinks() {
  const dial = CLINIC.phoneDial || CLINIC.phone.replace(/[^\d+]/g, "");
  const href = {
    call: `tel:${dial}`,
    whatsapp: `https://wa.me/${CLINIC.whatsapp}?text=${encodeURIComponent(`Hello ${CLINIC.name}, I'd like to ask about an appointment.`)}`,
    email: `mailto:${CLINIC.email}?subject=${encodeURIComponent("Appointment enquiry")}`,
  };
  document.querySelectorAll("[data-contact]").forEach(a => { a.href = href[a.dataset.contact]; });
  $("#cPhone").textContent = CLINIC.phone; $("#cWa").textContent = CLINIC.whatsappDisplay; $("#cEmail").textContent = CLINIC.email;
})();

/* ---------- chat assistant ---------- */
const chat = { open: false, turns: [], busy: false, ai: null };
const QUICK = ["What are your opening hours?", "How much is whitening?", "I have toothache", "Book a check-up this week", "Do you see children?"];
$("#quick").innerHTML = QUICK.map(q => `<button type="button">${esc(q)}</button>`).join("");
function addMsg(role, text) { const el = document.createElement("div"); el.className = "msg " + role; el.textContent = text; $("#msgs").appendChild(el); $("#msgs").scrollTop = 1e9; return el; }
function toggleChat(open) {
  chat.open = open ?? !chat.open; $("#chat").hidden = !chat.open; $("#contactFabs").classList.toggle("chat-open", chat.open); $("#chatFab").setAttribute("aria-expanded", chat.open);
  if (chat.open && !$("#msgs").children.length) addMsg("bot", "Hi, I'm Alder, the clinic's assistant. I can answer questions about treatments and prices, check live appointment times, and set up a booking for you. What can I help with?");
  if (chat.open) $("#chatInput").focus();
}
$("#chatFab").onclick = () => toggleChat(); $("#chatClose").onclick = () => toggleChat(false); $("#heroChat").onclick = () => toggleChat(true);
$("#quick").onclick = e => { const b = e.target.closest("button"); if (b) send(b.textContent); };
$("#chatForm").onsubmit = e => { e.preventDefault(); const v = $("#chatInput").value.trim(); if (v) { $("#chatInput").value = ""; send(v); } };
api("/api/chat/status").then(r => { chat.ai = r.enabled; if (!r.enabled) $("#chatMode").textContent = "Quick answers · call us for anything else"; }).catch(() => { chat.ai = false; });

function fallbackReply(q) {
  const t = q.toLowerCase();
  const svc = SERVICES.find(s => t.includes(s.id) || s.name.toLowerCase().split(/\W+/).some(w => w.length > 5 && t.includes(w)));
  if (/swell|breath|swallow|bleed|knocked/.test(t)) return `If you have swelling spreading to your eye or neck, trouble breathing or swallowing, or bleeding that won't stop, call your local emergency number now. For other urgent problems, call us on ${CLINIC.phone} or book an emergency appointment below.`;
  if (/pain|ache|hurt|broken|chipped|emergency/.test(t)) { prefill({ service_id: "emergency" }); return "Sorry you're in pain. I've opened an emergency appointment in the booking form; same-day times appear if we have them. Rinsing with warm salt water and over-the-counter pain relief can help until you're seen."; }
  if (/hour|open|close|sunday|saturday/.test(t)) return "Our hours: " + [1,2,3,4,5,6,0].map(d => `${DAYNAMES[d]} ${HOURS[d] ? HOURS[d].map(([a,b]) => `${hm(a)}–${hm(b)}`).join(", ") : "closed"}`).join("; ") + ".";
  if (/where|address|park|find|station/.test(t)) return `We're at ${CLINIC.address.join(", ")}. Free parking behind the building, with lift access.`;
  if (/insur|pay|card|finance|plan/.test(t)) return "We accept most major dental insurance plans and card payments, and offer payment plans for bigger treatments.";
  if (/child|kid|son|daughter/.test(t)) return `Yes, Dr. Maya Okafor sees children from age 2. A children's check-up is ${price(svcById("kids").price)} and takes 30 minutes.`;
  if (/cancel|reschedul|change/.test(t)) return `You can cancel under “Your bookings” next to the booking form, or call ${CLINIC.phone}. Please give 24 hours' notice.`;
  if (/book|appointment|slot|available/.test(t)) { prefill({ service_id: svc?.id || "checkup" }); return `I've set up ${svcById(B.service).name} in the booking form. Pick a day and time, add your details, then press Confirm booking.`; }
  if (svc) return `${svc.name}: ${svc.desc} It takes about ${svc.dur} minutes and costs ${price(svc.price)}${svc.price ? " and up" : ""}.`;
  if (/price|cost|how much/.test(t)) return "Starting prices: " + SERVICES.map(s => `${s.name} ${price(s.price)}`).join(", ") + ".";
  return `I can help with treatments, prices, opening hours and bookings. For anything else, call ${CLINIC.phone} or WhatsApp ${CLINIC.whatsappDisplay}.`;
}
async function send(text) {
  if (chat.busy) return;
  addMsg("me", text); chat.turns.push({ role: "user", content: text });
  chat.busy = true;
  const bubble = addMsg("bot", "…");
  let reply;
  if (chat.ai) {
    try {
      const r = await api("/api/chat", { messages: chat.turns.slice(-16) });
      reply = r.reply;
      for (const a of r.actions || []) if (a.type === "prefill") prefill(a);
    } catch (e) { reply = (e.status === 429 ? "I'm getting a lot of questions right now. " : "") + fallbackReply(text); }
  } else reply = fallbackReply(text);
  bubble.textContent = reply; chat.turns.push({ role: "assistant", content: reply });
  $("#msgs").scrollTop = 1e9;
  chat.busy = false;
}
