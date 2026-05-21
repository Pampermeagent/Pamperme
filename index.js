// AGENTE DE CITAS — PAMPER ME MOBILE NAILS & SPA
require("dotenv").config();
const express = require("express");
const twilio = require("twilio");
const { google } = require("googleapis");
const Anthropic = require("@anthropic-ai/sdk");
const Imap = require("imap");
const { simpleParser } = require("mailparser");
const nodemailer = require("nodemailer");
const fs = require("fs");

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Anti-duplicados: guarda IDs en archivo para sobrevivir reinicios
const PROCESSED_FILE = "/tmp/processed_emails.json";

function loadProcessedEmails() {
  try {
    if (fs.existsSync(PROCESSED_FILE)) {
      const data = JSON.parse(fs.readFileSync(PROCESSED_FILE, "utf8"));
      return new Set(data);
    }
  } catch(e) {}
  return new Set();
}

function saveProcessedEmails(set) {
  try {
    const arr = Array.from(set).slice(-200);
    fs.writeFileSync(PROCESSED_FILE, JSON.stringify(arr));
  } catch(e) {}
}

const processedEmails = loadProcessedEmails();
console.log(`📋 Correos procesados previamente: ${processedEmails.size}`);

const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const BUSINESS = {
  name: "Pamper Me Mobile Nails & Spa", owner: "Diana",
  phone: "215-490-1515", email: "agent@pampermemobilenails.com",
  coverage: ["Montgomery County", "Bucks County", "Delaware County", "Chester County", "Philadelphia", "parts of New Jersey"],
  services: `
MANICURES: Classic $45/30min, Gel $75/1hr, Kids $20, Teen $25
PEDICURES: Classic $75/1hr, Gehwol $100/1hr15min, Kids $40, Teen $50, Senior Mani-Pedi $130/1hr45min
COMBOS: Kids Mani/Pedi $55, Teen Mani/Pedi $70
ADD-ONS: French Design $15, Polish Change Fingers $25, Polish Change Toes $45, Remove Acrylic $30, 10min Massage $25
WAXING: Eyebrow $30, Lip $20, Chin $20
NOTE: Travel fee applies. Natural nails ONLY — NO acrylics.`
};

// ─── GOOGLE AUTH ────────────────────────────────────────────────────────────
function getGoogleAuth() {
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
  auth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return auth;
}

// ─── GOOGLE CALENDAR ─────────────────────────────────────────────────────────
async function getUpcomingAppointments() {
  const auth = getGoogleAuth();
  const calendar = google.calendar({ version: "v3", auth });
  const now = new Date();
  const start = new Date(now); start.setHours(0,0,0,0);
  const end = new Date(now); end.setDate(end.getDate()+1); end.setHours(23,59,59,999);
  const res = await calendar.events.list({
    calendarId: "primary",
    timeMin: start.toISOString(),
    timeMax: end.toISOString(),
    singleEvents: true,
    orderBy: "startTime"
  });
  return (res.data.items||[]).map(e=>({ title: e.summary, start: e.start.dateTime, address: e.location||"" }));
}

async function createAppointment(name, service, address, dt, mins) {
  const auth = getGoogleAuth();
  const calendar = google.calendar({ version: "v3", auth });
  const start = new Date(dt), end = new Date(start.getTime()+mins*60000);
  await calendar.events.insert({ calendarId: "primary", resource: {
    summary: `Pamper Me - ${name} (${service})`, location: address,
    start: { dateTime: start.toISOString(), timeZone: "America/New_York" },
    end: { dateTime: end.toISOString(), timeZone: "America/New_York" }
  }});
}

// ─── CLAUDE AI ───────────────────────────────────────────────────────────────
async function analyzeMessage(msg, appointments) {
  const appts = appointments.length > 0
    ? appointments.map(a=>`- ${a.title} at ${a.start}`).join("\n")
    : "No appointments yet.";
  const today = new Date().toLocaleDateString("en-US",{weekday:"long",timeZone:"America/New_York"});
  const time = new Date().toLocaleTimeString("en-US",{timeZone:"America/New_York",hour:"2-digit",minute:"2-digit"});

  const prompt = `You are a booking assistant for Pamper Me Mobile Nails & Spa (owner: Diana), based in Pennsylvania.
TODAY: ${today}, ${time} Eastern Time

BOOKING FLOW — follow this exact order:

STEP 1 - COLLECT BASIC INFO FIRST:
- If the client has NOT provided BOTH a date AND an address, ask for both before doing anything else.
- Do NOT proceed to the next steps until you have both date and address.
- Example: "To get started, could you please let us know your preferred date and the address where you would like us to come?"

STEP 2 - DETECT SENIOR/SPECIAL NEEDS:
- If the client mentions: "mom", "mama", "mother", "mamá", "elderly", "grandma", "abuela", "disabled", "wheelchair", "special needs", "discapacidad", or any indication of limited mobility:
  - Automatically recommend Senior services:
    - Senior Manicure: $55
    - Senior Pedicure: $90
    - Senior Manicure & Pedicure: $130
  - Mention these are specially designed for seniors and those with special needs.

STEP 3 - VERIFY ADDRESS:
- Coverage area: Delaware County, Chester County, Philadelphia metropolitan area and surrounding areas of Philadelphia.
- If address is OUTSIDE coverage: apologize warmly and explain we cannot provide service in that area.
- If address is INSIDE coverage: continue to Step 4.

STEP 4 - INFORM TRAVEL FEE:
- Let the client know a travel/accommodation fee applies and that our team will confirm the exact amount based on their location.
- Ask the client to reply so the team can confirm the travel fee and send the payment link.
- Payment accepted via Zelle (bank to bank) or other apps like Venmo/CashApp/PayPal.

STEP 5 - CHECK CALENDAR:
- If the requested date has a "Vacaciones", "No disponible", "Blocked", "Holiday", or "Out of office" event: apologize and let the client know we are not available that day, and suggest they pick another date.
- If it is the first appointment of the day: offer to schedule it.
- If there are already appointments that day: the new appointment must be within 20 minutes of the existing ones, otherwise suggest a different date.

STEP 6 - PAYMENT REQUIRED:
- Inform that appointments are confirmed only with payment (50% deposit).
- Ask the client to reply to this email so the team can send the payment link.

OTHER RULES:
- Hours: Tue-Fri 9:30am-5pm, Sat 10am-5pm. CLOSED Sunday and Monday.
- Book appointments up to 7 days in advance.
- No acrylic nails - natural nails ONLY. If requested, decline politely.
- Detect language and reply in SAME LANGUAGE as the client.
- Structure EVERY reply in exactly 3 paragraphs separated by blank lines:

PARAGRAPH 1 - GREETING:
- Greet the client warmly and cordially in a natural, professional way.
- Do NOT use a fixed template — vary the greeting naturally each time.
- Always mention "Pamper Me" Mobile Nails & Spa in the greeting.
- Match the language of the client (English or Spanish).

PARAGRAPH 2 - DETAILS:
The main content of the response — ask for missing info, confirm coverage area, mention travel fee, request payment, etc.

PARAGRAPH 3 - SIGN OFF (always end with this exact text):
"Warmly,
"Pamper Me" Mobile Nails & Spa ✨"
In Spanish: "Con cariño,
"Pamper Me" Mobile Nails & Spa ✨"
- Be warm, cordial, professional. Use occasional emoji 💅✨
- NEVER use markdown (no asterisks, no bold, no bullets). Plain text only.
- Keep replies concise and friendly.

SQUARESPACE FORMS: If message has NAME/PHONE/EMAIL/ADDRESS OF SERVICE/SERVICE DETAILS fields, extract automatically and use client EMAIL to reply.

SERVICES: ${BUSINESS.services}
APPOINTMENTS TODAY/THIS WEEK: ${appts}
MESSAGE: "${msg}"

Reply ONLY with JSON (no backticks, no markdown):
{"language":"en","needs_address":false,"detected_address":null,"client_email":null,"appointment_requested":false,"acrylic_requested":false,"out_of_coverage":false,"client_name":null,"service_requested":null,"service_duration_mins":60,"proposed_datetime":null,"zone_ok":true,"reply":"your plain text reply here"}`;

  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1000,
    messages: [{ role: "user", content: prompt }]
  });
  return JSON.parse(response.content[0].text.replace(/```json|```/g,"").trim());
}

async function processMessage(text, appointments) {
  const a = await analyzeMessage(text, appointments);
  if (a.appointment_requested && !a.acrylic_requested && a.detected_address && a.proposed_datetime && a.client_name) {
    try {
      await createAppointment(a.client_name, a.service_requested||"Nail Service", a.detected_address, a.proposed_datetime, a.service_duration_mins||60);
      console.log(`✅ Agendado: ${a.client_name}`);
    } catch(e) { console.error("⚠️ Calendar error:", e.message); }
  }
  return a;
}

// ─── GMAIL IMAP (LEER) ───────────────────────────────────────────────────────
function getImap() {
  return new Imap({
    user: process.env.AGENT_EMAIL,
    password: process.env.AGENT_APP_PASSWORD,
    host: "imap.gmail.com",
    port: 993,
    tls: true,
    tlsOptions: { rejectUnauthorized: false }
  });
}

async function getUnreadEmails() {
  return new Promise((resolve, reject) => {
    const imap = getImap();
    const results = [];
    imap.once("ready", () => {
      imap.openBox("INBOX", false, (err) => {
        if (err) return reject(err);
        imap.search(["UNSEEN"], (err, uids) => {
          if (err) return reject(err);
          if (!uids || uids.length===0) { imap.end(); return resolve([]); }
          const fetch = imap.fetch(uids.slice(0,5), { bodies: "", markSeen: true });
          fetch.on("message", (msg) => {
            let buf = "";
            msg.on("body", (stream) => {
              stream.on("data", c => buf+=c.toString("utf8"));
              stream.once("end", async () => {
                const p = await simpleParser(buf);
                results.push({
                  from: p.from?.text||"",
                  replyTo: p.replyTo?.text||p.from?.text||"",
                  subject: p.subject||"",
                  body: p.text||""
                });
              });
            });
          });
          fetch.once("end", () => { setTimeout(()=>{ imap.end(); resolve(results); }, 1000); });
        });
      });
    });
    imap.once("error", reject);
    imap.connect();
  });
}

// ─── NODEMAILER (ENVIAR) ─────────────────────────────────────────────────────
async function sendReply(to, subject, replyText) {
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.AGENT_EMAIL,
      pass: process.env.AGENT_APP_PASSWORD
    }
  });

  const fullText = `${replyText}\n\n---\n"Pamper Me" Mobile Nails & Spa\n📱 215-490-1515\n🌐 pampermemobilenails.com`;
  const subj = subject.startsWith("Re:") ? subject : `Re: ${subject}`;

  await transporter.sendMail({
    from: `"Pamper Me Mobile Nails" <${process.env.AGENT_EMAIL}>`,
    to,
    replyTo: process.env.AGENT_EMAIL,
    subject: subj,
    text: fullText
  });

  console.log(`📁 Email enviado via Gmail SMTP a ${to}`);
}

// ─── WEBHOOKS TWILIO ─────────────────────────────────────────────────────────
app.post("/webhook/sms", async (req, res) => {
  const body = req.body.Body||"", from = req.body.From||"";
  console.log(`💬 SMS de ${from}: ${body}`);
  try {
    const appts = await getUpcomingAppointments().catch(()=>[]);
    const a = await processMessage(body, appts);
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message(a.reply);
    res.type("text/xml").send(twiml.toString());
  } catch(err) { console.error("❌ SMS:", err.message); res.status(500).send("Error"); }
});

app.post("/webhook/voice", async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const g = twiml.gather({ input: "speech", action: "/webhook/voice/process", method: "POST", language: "en-US", speechTimeout: "auto" });
  g.say({ voice: "Polly.Joanna" }, "Thank you for calling Pamper Me Mobile Nails! How can I help you? Gracias por llamar a Pamper Me. ¿En qué le puedo ayudar?");
  res.type("text/xml").send(twiml.toString());
});

app.post("/webhook/voice/process", async (req, res) => {
  const speech = req.body.SpeechResult||"", caller = req.body.From||"";
  const twiml = new twilio.twiml.VoiceResponse();
  try {
    const appts = await getUpcomingAppointments().catch(()=>[]);
    const a = await processMessage(speech, appts);
    twiml.say({ voice: a.language==="es"?"Polly.Conchita":"Polly.Joanna" }, a.reply);
    if (a.appointment_requested && a.proposed_datetime) {
      await twilioClient.messages.create({
        from: process.env.TWILIO_PHONE_NUMBER,
        to: caller,
        body: `✅ Pamper Me: Appointment confirmed! 💅 ${a.service_requested||"Nail Service"} at ${a.detected_address}. Questions: 215-490-1515`
      });
    }
  } catch(err) { twiml.say({ voice: "Polly.Joanna" }, "Sorry, please text 215-490-1515 to book."); }
  res.type("text/xml").send(twiml.toString());
});

// ─── CHECK GMAIL ─────────────────────────────────────────────────────────────
async function checkGmail() {
  try {
    const emails = await getUnreadEmails();
    if (emails.length===0) { console.log("📭 No hay correos nuevos"); return; }
    console.log(`📧 ${emails.length} correo(s) nuevo(s) en Gmail`);
    const appts = await getUpcomingAppointments().catch(()=>{ console.log("⚠️ Calendar no disponible"); return []; });

    for (const email of emails) {
      try {
        const emailId = `${email.from}-${email.subject}-${(email.body||"").substring(0,50)}`;

        if (processedEmails.has(emailId)) {
          console.log(`⏭️ Correo ya procesado, saltando: ${email.from}`);
          continue;
        }

        processedEmails.add(emailId);
        saveProcessedEmails(processedEmails);

        console.log(`📨 Procesando de: ${email.from}`);
        const body = email.body||email.subject||"";
        console.log(`📝 Contenido: ${body.substring(0,100)}`);
        const a = await processMessage(body, appts);
        console.log(`🤖 Respuesta lista: ${a.reply.substring(0,50)}`);

        let to = email.replyTo||email.from;
        if (a.client_email) {
          to = a.client_email;
          console.log(`📋 Formulario Squarespace detectado, respondiendo a cliente: ${to}`);
        }

        console.log(`📤 Enviando a: ${to}`);
        await sendReply(to, email.subject, a.reply);
        console.log(`✉️ Respuesta enviada a ${to}`);

        // Aviso urgente a Diana si hay cita completa
        if (a.appointment_requested && !a.acrylic_requested && !a.out_of_coverage &&
            a.detected_address && a.service_requested && a.client_name) {

          const dianaAlert = `🚨 NUEVA SOLICITUD DE CITA - ACCIÓN REQUERIDA 🚨

Cliente: ${a.client_name || "No especificado"}
Email: ${a.client_email || to}
Dirección: ${a.detected_address || "No especificada"}
Servicio: ${a.service_requested || "No especificado"}
Fecha solicitada: ${a.proposed_datetime || "Por confirmar"}

ACCIÓN REQUERIDA:
1. Confirmar el costo del travel fee segun la direccion
2. Enviar link de pago al cliente (50% de deposito)
3. Confirmar la cita una vez recibido el pago

El agente ya respondio al cliente y le indico que debe pagar para confirmar la cita.

--- Pamper Me Agent ---`;

          await sendReply(
            "agent@pampermemobilenails.com",
            "🚨 NUEVA SOLICITUD DE CITA - ACCION REQUERIDA",
            dianaAlert
          );
          console.log(`🔔 Aviso urgente enviado a Diana`);

          // Evento urgente en Google Calendar
          try {
            const auth = getGoogleAuth();
            const calendar = google.calendar({ version: "v3", auth });
            const now = new Date();
            const eventStart = new Date(now.getTime() + 2 * 60000);
            const eventEnd = new Date(now.getTime() + 17 * 60000);

            await calendar.events.insert({
              calendarId: "primary",
              resource: {
                summary: `🚨 NUEVA SOLICITUD - ${a.client_name || "Cliente"}`,
                description: `ACCION REQUERIDA:\n\nCliente: ${a.client_name || "No especificado"}\nEmail: ${a.client_email || to}\nDireccion: ${a.detected_address || "No especificada"}\nServicio: ${a.service_requested || "No especificado"}\nFecha: ${a.proposed_datetime || "Por confirmar"}\n\n1. Confirmar travel fee\n2. Enviar link de pago (50% deposito)`,
                start: { dateTime: eventStart.toISOString(), timeZone: "America/New_York" },
                end: { dateTime: eventEnd.toISOString(), timeZone: "America/New_York" },
                reminders: {
                  useDefault: false,
                  overrides: [{ method: "popup", minutes: 0 }]
                }
              }
            });
            console.log(`📅 Evento urgente creado en Google Calendar`);
          } catch(calErr) {
            console.error("⚠️ No se pudo crear evento en Calendar:", calErr.message);
          }
        }
      } catch(e) {
        console.error(`❌ Error correo:`, e.message);
        console.error(`❌ Stack:`, e.stack);
      }
    }
  } catch(err) { console.error("❌ Gmail check:", err.message, err.stack); }
}

setInterval(checkGmail, 5 * 60 * 1000);

app.get("/", (req, res) => res.send("<h2>💅 Pamper Me Agent — Active</h2>"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Pamper Me Agent running on port ${PORT}`);
  console.log(`📧 Checking Gmail every 5 minutes...`);
  checkGmail();
});
