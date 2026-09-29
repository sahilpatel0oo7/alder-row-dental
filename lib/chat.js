// "Ask Alder" chat assistant, powered by Claude. Enabled when ANTHROPIC_API_KEY is set.
import Anthropic from "@anthropic-ai/sdk";
import clinic from "../shared/clinic.config.js";
import { DAYNAMES, hm, ymd, parseYmd, isYmd, isHm, slotStarts, freeDentists } from "../shared/schedule.js";
import { busyFor } from "./db.js";

export const chatEnabled = !!process.env.ANTHROPIC_API_KEY;
const client = chatEnabled ? new Anthropic() : null;
const MODEL = process.env.CHAT_MODEL || "claude-opus-5-5";
const price = p => (p === 0 ? "free" : `${clinic.currency}${p}`);

function systemPrompt() {
  const now = new Date();
  return `You are "Alder", the friendly front-desk assistant on the website of ${clinic.name}, a dental clinic at ${clinic.address.join(", ")}. Phone ${clinic.phone}, WhatsApp ${clinic.whatsappDisplay}, email ${clinic.email}.
Today is ${DAYNAMES[now.getDay()]} ${ymd(now)}, and the time is ${hm(now.getHours() * 60 + now.getMinutes())}.
Opening hours: ${[1, 2, 3, 4, 5, 6, 0].map(d => `${DAYNAMES[d]} ${clinic.hours[d] ? clinic.hours[d].map(([a, b]) => `${hm(a)}-${hm(b)}`).join(", ") : "closed"}`).join("; ")}.
Dentists:
${clinic.dentists.map(d => `- ${d.name} (id ${d.id}): ${d.role}. ${d.bio}`).join("\n")}
Treatments (id | name | length | starting price | dentist ids | description):
${clinic.services.map(s => `- ${s.id} | ${s.name} | ${s.dur} min | ${price(s.price)} | ${s.docs.join("/")} | ${s.desc}`).join("\n")}
Policies: ${clinic.policies}

How to help:
- Keep replies short (1-4 sentences), warm and plain text. No markdown headings or tables.
- Before quoting appointment times, call check_availability. Never invent times.
- When the patient wants to book, call prefill_booking with the treatment and, if agreed, the date, time and dentist. Then tell them to add their name, phone and email in the booking form and press "Confirm booking". You cannot complete a booking yourself.
- To cancel or change a booking: use "Your bookings" beside the booking form, or call/WhatsApp the clinic.
- You are not a dentist and must not diagnose. For pain, suggest an emergency appointment. For facial swelling spreading towards the eye or neck, trouble breathing or swallowing, heavy bleeding that won't stop, or a knocked-out adult tooth, tell them to call local emergency services or come in immediately.
- Only discuss this clinic and dental topics.`;
}

const tools = [
  {
    name: "check_availability",
    description: "Get the free online start times for a treatment on a date, with which dentists are free at each time. Times are 24h HH:MM in the clinic's local time.",
    input_schema: {
      type: "object",
      properties: {
        date: { type: "string", description: "YYYY-MM-DD" },
        service_id: { type: "string", enum: clinic.services.map(s => s.id) },
        dentist_id: { type: "string", enum: ["any", ...clinic.dentists.map(d => d.id)] },
      },
      required: ["date", "service_id"],
    },
  },
  {
    name: "prefill_booking",
    description: "Fill in the booking form on the page the patient is viewing (treatment, and optionally date, time and dentist) and scroll them to it.",
    input_schema: {
      type: "object",
      properties: {
        service_id: { type: "string", enum: clinic.services.map(s => s.id) },
        date: { type: "string", description: "YYYY-MM-DD" },
        time: { type: "string", description: "HH:MM" },
        dentist_id: { type: "string", enum: clinic.dentists.map(d => d.id) },
      },
      required: ["service_id"],
    },
  },
];

function runTool(name, input, actions) {
  if (name === "check_availability") {
    const svc = clinic.services.find(s => s.id === input.service_id);
    if (!svc) return { error: "unknown service_id" };
    if (!isYmd(input.date)) return { error: "date must be YYYY-MM-DD" };
    const starts = slotStarts(clinic, input.date, svc.dur);
    if (!starts.length) return { date: input.date, weekday: DAYNAMES[parseYmd(input.date).getDay()], bookable: false, reason: "closed, in the past, or beyond the online booking window" };
    const busy = busyFor(input.date);
    const free = starts.map(m => ({ time: hm(m), dentists: freeDentists(svc, m, busy, input.dentist_id || "any") })).filter(x => x.dentists.length);
    return { date: input.date, weekday: DAYNAMES[parseYmd(input.date).getDay()], service: svc.name, bookable: free.length > 0, free: free.slice(0, 24) };
  }
  if (name === "prefill_booking") {
    const a = { type: "prefill", service_id: input.service_id };
    if (isYmd(input.date)) a.date = input.date;
    if (isHm(input.time)) a.time = input.time;
    if (clinic.dentists.some(d => d.id === input.dentist_id)) a.dentist_id = input.dentist_id;
    actions.push(a);
    return { ok: true, note: "The booking form on the page is now filled in. The patient still needs to enter their details and confirm." };
  }
  return { error: `unknown tool ${name}` };
}

/** history: [{role: "user"|"assistant", content: string}] ending with the user's newest message. */
export async function chatReply(history) {
  const messages = history.map(m => ({ role: m.role, content: m.content }));
  const actions = [];
  for (let round = 0; round < 6; round++) {
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 4000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low" },
      system: systemPrompt(),
      tools,
      messages,
    });

    if (response.stop_reason === "refusal") {
      return { reply: `Sorry, I can't help with that here. For anything else, call us on ${clinic.phone}.`, actions };
    }
    if (response.stop_reason === "tool_use" || response.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: response.content });
      if (response.stop_reason === "pause_turn") continue;
      const results = response.content
        .filter(b => b.type === "tool_use")
        .map(b => {
          let out;
          try { out = runTool(b.name, b.input ?? {}, actions); } catch (e) { out = { error: e.message }; }
          return { type: "tool_result", tool_use_id: b.id, content: JSON.stringify(out), ...(out?.error ? { is_error: true } : {}) };
        });
      messages.push({ role: "user", content: results });
      continue;
    }
    const reply = response.content.filter(b => b.type === "text").map(b => b.text).join("").trim();
    return { reply: reply || "Sorry, could you say that another way?", actions };
  }
  return { reply: `I couldn't finish that. Please try again, or call us on ${clinic.phone}.`, actions };
}
