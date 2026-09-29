// Public clinic details. This file is sent to browsers, so never put passwords,
// API keys or private contact details here — those go in .env.
export default {
  name: "Alder Row Dental",
  currency: "$",
  phone: "(555) 014-2290",             // shown on the site
  phoneDial: "+15550142290",            // what the Call button dials: + country code + number
  whatsapp: "917489791016",            // country code + number, digits only
  whatsappDisplay: "+91 74897 91016",
  email: "hello@alderrow.example",
  address: ["48 Alder Row, Second floor", "Riverside RS4 2PL"],
  defaultCountryCode: "91",             // added to 10-digit patient numbers

  // Opening hours in minutes from midnight, per weekday (0 = Sunday). null = closed.
  hours: {
    0: null,
    1: [[510, 780], [840, 1080]],
    2: [[510, 780], [840, 1080]],
    3: [[510, 780], [840, 1080]],
    4: [[510, 780], [840, 1200]],
    5: [[510, 780], [840, 1080]],
    6: [[540, 840]],
  },
  bookingDaysAhead: 21,
  minLeadMinutes: 30,                   // online patients can't book closer to now than this

  dentists: [
    { id: "maya", name: "Dr. Maya Okafor", role: "General & family dentistry", bio: "Leads check-ups, children's care and root canal treatment. Known for calm, unhurried appointments.", tags: ["Nervous patients", "Children", "Endodontics"], hue: "#0B6E66" },
    { id: "ravi", name: "Dr. Ravi Menon", role: "Implants & oral surgery", bio: "Plans implants with 3D scans and guided surgery. Also handles wisdom teeth and complex root canals.", tags: ["Implants", "Extractions", "3D planning"], hue: "#3E6A8A" },
    { id: "lena", name: "Dr. Lena Sørensen", role: "Orthodontics & cosmetic", bio: "Clear aligners, veneers and smile design. Shows you a digital preview before you commit.", tags: ["Clear aligners", "Veneers", "Whitening"], hue: "#8A5A3E" },
  ],

  // dur must be a multiple of 30 minutes; price 0 shows as "Free".
  services: [
    { id: "checkup", name: "Check-up & hygiene clean", dur: 60, price: 85, docs: ["maya", "ravi", "lena"], desc: "Full exam, gum check, scale and polish. X-rays when needed.", icon: "M12 3c-3 0-5 2-5 5 0 4 1 6 2 10 .4 1.6 1 3 2 3s1-3 1-5 0 5 1 5 1.6-1.4 2-3c1-4 2-6 2-10 0-3-2-5-5-5z" },
    { id: "whitening", name: "In-chair whitening", dur: 90, price: 390, docs: ["lena", "maya"], desc: "Professional whitening in one visit, with a take-home top-up kit.", icon: "M12 2v4M12 18v4M4.9 4.9l2.8 2.8M16.3 16.3l2.8 2.8M2 12h4M18 12h4M4.9 19.1l2.8-2.8M16.3 7.7l2.8-2.8" },
    { id: "aligners", name: "Clear aligner consultation", dur: 30, price: 0, docs: ["lena"], desc: "Digital scan and a preview of your new smile. No obligation.", icon: "M3 12c3-5 15-5 18 0M3 12c3 5 15 5 18 0" },
    { id: "implants", name: "Implant consultation", dur: 30, price: 60, docs: ["ravi"], desc: "3D scan, options for missing teeth, and a written treatment plan.", icon: "M12 2v6M8 8h8l-1 4H9zM10 12l1 10h2l1-10" },
    { id: "rootcanal", name: "Root canal treatment", dur: 90, price: 650, docs: ["maya", "ravi"], desc: "Saves an infected tooth. Done under local anaesthetic, usually in one visit.", icon: "M12 3c-3 0-5 2-5 5 0 3 1 5 2 7l1 6M12 3c3 0 5 2 5 5 0 3-1 5-2 7l-1 6" },
    { id: "emergency", name: "Emergency appointment", dur: 30, price: 95, docs: ["maya", "ravi", "lena"], desc: "Toothache, a broken tooth or a lost filling. Same-day where we can.", icon: "M12 2v20M2 12h20" },
    { id: "kids", name: "Children's check-up", dur: 30, price: 45, docs: ["maya"], desc: "A gentle check for ages 2–15, with fluoride and sealants where useful.", icon: "M12 4a4 4 0 1 1 0 8 4 4 0 0 1 0-8zM5 21c1-4 4-6 7-6s6 2 7 6" },
    { id: "veneers", name: "Veneers & smile design", dur: 30, price: 60, docs: ["lena", "maya"], desc: "Talk through veneers or bonding, with a digital mock-up of the result.", icon: "M4 6h16v12H4zM9 6v12M15 6v12" },
  ],

  policies: "Accepts most major dental insurance plans and card payments; bring your insurance card and ID. Please give 24 hours' notice to cancel. New patients arrive 10 minutes early. Payment plans are available for treatments over $500. Children are seen from age 2. Free parking behind the building, lift access, 2 minutes from Riverside station.",
};
