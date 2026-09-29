# Alder Row Dental

Clinic website with live online booking, a password-protected staff front desk, automatic WhatsApp and email alerts for every booking, and an AI chat assistant.

- **Patients** book at `/`. Taken times update live, and double-booking is impossible.
- **Staff** sign in at `/admin` with their own phone number and password. There they can:
  - see every booking, add phone/walk-in bookings, block time, and mark patients arrived/done
  - read patient feedback
  - add or remove staff accounts
- **Patients** can leave a star rating and comment at the bottom of the site.
- **When someone books or cancels online**, the server immediately:
  - sends a WhatsApp message and an email to the clinic, plus the dentist's own address/number if set
  - emails the patient a confirmation
- Each booking in `/admin` shows whether its alerts were sent (✓) or failed (✗, hover for the reason).

## 1. Where it runs

The site runs on **Netlify**, which gives it these parts:
- **Pages:** the `public/` folder.
- **Booking logic:** one Netlify Function, `netlify/functions/api.mjs`, which answers every `/api/*` request.
- **Data:** bookings, staff, feedback and the alert log are kept in **Netlify Blobs**. They stay saved across deploys.
- **Double-booking protection:** each 30-minute chair slot is saved with a "create only if it doesn't exist yet" write, so two people can't book the same slot even at the same second.

Live site: https://alder-row-dental-clinic.netlify.app (staff desk: `/admin`)

### Run it on your computer

```bash
npm install
cp .env.example .env      # then edit .env
npx netlify dev           # http://localhost:8888
```

### Publish changes

```bash
npx netlify deploy --prod --dir public --functions netlify/functions
```

**Settings (passwords, alert addresses, API keys)** go in the Netlify dashboard, not in the code: Project → **Site configuration → Environment variables**. The settings are the same ones listed in `.env.example`. Redeploy after changing them.

### First sign-in and staff accounts

On the very first request, the site creates one staff account from the environment variables:

```
ADMIN_NAME=Clinic owner
ADMIN_PHONE=7489791016
ADMIN_PASSWORD=choose-a-long-password
```

Sign in with that number and password. Then, in the **Staff** tab:
- **Add a staff member:** enter their name, phone number and a starting password (8+ characters). Give them the password in person.
- **Remove a staff member:** they are signed out on every device immediately.
- **Change my password:** do this after your first sign-in. It signs out your other devices.

Rules:
- Anyone signed in can add or remove staff.
- Nobody can remove their own account, and the last account can't be removed.
- Passwords are stored hashed (scrypt), never in plain text.
- Ten wrong sign-in attempts lock that connection out for 15 minutes.

Once the first account exists, the `ADMIN_*` lines are ignored, so you can delete them from `.env`.

## 2. Email alerts (Gmail)

1. Use a Gmail account for the clinic and turn on 2-Step Verification.
2. Go to Google Account → Security → **App passwords**, create one called "Clinic website", and copy the 16-character password.
3. In `.env`:
   ```
   SMTP_HOST=smtp.gmail.com
   SMTP_PORT=465
   SMTP_USER=yourclinic@gmail.com
   SMTP_PASS=the16charapppassword
   NOTIFY_EMAILS=doctor@example.com
   ```
   `NOTIFY_EMAILS` can hold several addresses separated by commas.

## 3. WhatsApp alerts

Pick one option.

**Option A: CallMeBot.** Free, good for alerts to your own phone.

1. Go to callmebot.com → WhatsApp API, and follow the steps: save their number in your contacts and send it the activation message from **your** WhatsApp.
2. It replies with your API key.
3. In `.env`:
   ```
   WHATSAPP_PROVIDER=callmebot
   NOTIFY_WHATSAPP=917489791016:YOUR_API_KEY
   ```
   Every phone that should get alerts does its own activation and gets its own key. Separate entries with commas.

It's a free community service, so for a busy clinic use Option B.

**Option B: Twilio.** Business-grade and paid per message.

1. Create a Twilio account and enable the WhatsApp sender. The sandbox works for testing; a registered WhatsApp Business sender is needed for production.
2. In `.env`:
   ```
   WHATSAPP_PROVIDER=twilio
   TWILIO_ACCOUNT_SID=AC...
   TWILIO_AUTH_TOKEN=...
   TWILIO_WHATSAPP_FROM=+14155238886
   NOTIFY_WHATSAPP=917489791016
   ```

After setting either option, redeploy, open `/admin`, and press **Send test alert**.

### Per-dentist alerts

Each dentist can also get alerts for their own bookings only:

```
NOTIFY_MAYA_EMAIL=maya@example.com
NOTIFY_MAYA_WHATSAPP=91XXXXXXXXXX:APIKEY
```

The IDs (`maya`, `ravi`, `lena`) are in `shared/clinic.config.js`.

## 4. Chat assistant (optional)

Put an Anthropic API key in `ANTHROPIC_API_KEY`. The assistant then:
- answers questions
- checks real open times
- fills in the booking form for the patient

It uses Claude Opus 5.5 at low effort, with Anthropic's server-side refusal fallback turned on. You pay Anthropic per message. Without a key, the chat still gives quick built-in answers.

## 5. Make it your clinic

Edit `shared/clinic.config.js` for:
- name, phone, WhatsApp number, address
- opening hours
- dentists
- treatments and prices
- currency

Redeploy after changes. The clinic photos are illustrations in `public/index.html`; replace them with your own images.

## 6. A custom domain

When a clinic buys the site, go to Netlify → Project → **Domain management → Add a domain**. Netlify sets up HTTPS for it automatically.

## Notes

- All times are in `CLINIC_TZ` (default `Asia/Kolkata`).
- Open pages check for new bookings every 15 seconds.
- Staff bookings from `/admin` don't alert the clinic by default, since staff entered them. Set `NOTIFY_ON_STAFF_BOOKINGS=true` to change that. Patients with an email still get a confirmation.
- Patients cancel from "Your bookings" on the same device. The reference plus their phone number is required.
