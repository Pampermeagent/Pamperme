// AGENTE DE CITAS — PAMPER ME MOBILE NAILS & SPA
require("dotenv").config();
const express = require("express");
const twilio = require("twilio");
const { google } = require("googleapis");
const Anthropic = require("@anthropic-ai/sdk");
const Imap = require("imap");
const { simpleParser } = require("mailparser");
const sgMail = require("@sendgrid/mail");

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Anti-duplicados: guarda IDs en archivo para sobrevivir reinicios
const fs = require("fs");
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
    const arr = Array.from(set).slice(-200); // Guardar solo los últimos 200
    fs.writeFileSync(PROCESSED_FILE, JSON.stringify(arr));
  } catch(e) {}
}

const processedEmails = loadProcessedEmails();
console.log(`📋 Correos procesados previamente: ${processedEmails.size}`);

// Registro de respuestas enviadas por cliente con timestamp (en memoria)
const RESPONSES_FILE = "/tmp/sent_responses.json";

function loadSentResponses() {
  try {
    if (fs.existsSync(RESPONSES_FILE)) {
      return new Map(JSON.parse(fs.readFileSync(RESPONSES_FILE, "utf8")));
    }
  } catch(e) {}
  return new Map();
}

function saveSentResponses(map) {
  try {
    fs.writeFileSync(RESPONSES_FILE, JSON.stringify(Array.from(map.entries())));
  } catch(e) {}
}

const sentResponses = loadSentResponses();
console.log(`📤 Respuestas enviadas registradas: ${sentResponses.size}`);

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

function getGoogleAuth() {
  const auth = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, process.env.GOOGLE_REDIRECT_URI);
  auth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return auth;
}

async function getUpcomingAppointments() {
  const auth = getGoogleAuth();
  const calendar = google.calendar({ version: "v3", auth });
  const now = new Date();
  const start = new Date(now); start.setHours(0,0,0,0);
  const end = new Date(now); end.setDate(end.getDate()+1); end.setHours(23,59,59,999);
  const res = await calendar.events.list({ calendarId: "primary", timeMin: start.toISOString(), timeMax: end.toISOString(), singleEvents: true, orderBy: "startTime" });
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

async function analyzeMessage(msg, appointments) {
  const appts = appointments.length > 0 ? appointments.map(a=>`- ${a.title} at ${a.start}`).join("\n") : "No appointments yet.";
  const todayFull = new Date().toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric",year:"numeric",timeZone:"America/New_York"});
  const today = new Date().toLocaleDateString("en-US",{weekday:"long",timeZone:"America/New_York"});
  const time = new Date().toLocaleTimeString("en-US",{timeZone:"America/New_York",hour:"2-digit",minute:"2-digit"});

  const prompt = `You are a booking assistant for Pamper Me Mobile Nails & Spa (owner: Diana), based in Pennsylvania.
TODAY: ${todayFull} at ${time} Eastern Time. Use this date to calculate things like "next Monday", "tomorrow", etc.

BOOKING FLOW — follow this exact order:

STEP 1 - COLLECT BASIC INFO FIRST:
- If the client has NOT provided BOTH a date AND an address, ask for both before doing anything else.
- Do NOT proceed to the next steps until you have both date and address.
- Example: "To get started, could you please let us know your preferred date and the address where you would like us to come?"

STEP 2 - DETECT SENIOR/SPECIAL NEEDS:
- If the client mentions ANY of these keywords: "mom", "mama", "mother", "mamá", "madre", "elderly", "grandma", "abuela", "disabled", "wheelchair", "special needs", "discapacidad", "fungus", "hongos", "diabetic", "diabético", or any indication of limited mobility:
  - Automatically recommend Senior services:
    - Senior Manicure: $55
    - Senior Pedicure: $90
    - Senior Manicure & Pedicure: $130
  - Mention these are specially designed for seniors and those with special needs or medical conditions.

IMPORTANT NOTE: The owner of the business is Diana, but clients writing to us can ALSO be named Diana. If the form submission shows a client name like "Diana Llanos" or similar, treat them as a regular client (do NOT assume they are the owner). Just use their first name in the greeting if available.

STEP 3 - VERIFY ADDRESS:
- Coverage area: Delaware County, Chester County, Philadelphia metropolitan area and surrounding areas of Philadelphia.
- If address is OUTSIDE coverage: apologize warmly and explain we cannot provide service in that area.
- If address is INSIDE coverage: continue to Step 4.

STEP 4 - INFORM TRAVEL FEE (IMPORTANT - ALWAYS MENTION):
- ALWAYS clearly mention that a travel/accommodation fee applies to all mobile services because we bring our luxury services directly to the client's location.
- The exact amount will be confirmed by our team based on the distance to their location.
- Do NOT mention specific payment methods. Just say the team will send a payment link.

STEP 5 - DO NOT CONFIRM DATES OR TIMES:
- NEVER confirm a specific date or time as available.
- NEVER say "we can schedule you for X day at Y time".
- Instead say: "Our team will review the calendar and confirm availability for your preferred date, or suggest the closest available date that works best for everyone."
- Diana is the one who decides which dates are available and confirms with the client.
- The agent's job is only to collect the information (name, address, service, preferred date) and pass it to Diana.

STEP 6 - PAYMENT REQUIRED:
- ALWAYS remind the client that to confirm the appointment a 50% deposit is required.
- Ask the client to reply to this email so the team can send the payment link.
- Do NOT specify payment methods - the team will send the payment link directly.

STEP 7 - REMIND COVERAGE AREAS:
- ALWAYS mention in the reply the service areas: Delaware County, Chester County, Philadelphia metropolitan area and surrounding areas of Philadelphia.
- This way the client knows exactly where we serve.

STEP 8 - IGNORE PROMOTIONAL/NON-CUSTOMER EMAILS:
- If the message is promotional, advertising, newsletter, marketing offer, business solicitation, or NOT a real customer inquiry about nail services, DO NOT respond with a booking message.
- Instead reply with: {"reply": "IGNORE_PROMO"} so we can skip it.
- Only respond to messages that are genuine inquiries from potential or existing clients about Pamper Me nail services.

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
\"Pamper Me\" Mobile Nails & Spa ✨"
In Spanish: "Con cariño,
\"Pamper Me\" Mobile Nails & Spa ✨"
- Be warm, cordial, professional. Use occasional emoji 💅✨
- NEVER use markdown (no asterisks, no bold, no bullets). Plain text only.
- Keep replies concise and friendly.
- IMPORTANT: The business name is ALWAYS "Pamper Me Mobile Nails & Spa" in English. NEVER translate it to Spanish (do NOT say "Uñas y Spa Móvil"). Keep it exactly as "Pamper Me Mobile Nails & Spa" in any language.
- CRITICAL: Use real paragraph breaks (double newlines \n\n) between the 3 paragraphs. Each paragraph must be visually separated.

SQUARESPACE FORMS: If message has NAME/PHONE/EMAIL/ADDRESS OF SERVICE/SERVICE DETAILS fields, extract automatically and use client EMAIL to reply.

SERVICES: ${BUSINESS.services}
APPOINTMENTS TODAY/THIS WEEK: ${appts}
MESSAGE: "${msg}"

Reply ONLY with JSON (no backticks, no markdown):
{"language":"en","needs_address":false,"detected_address":null,"client_email":null,"appointment_requested":false,"acrylic_requested":false,"out_of_coverage":false,"client_name":null,"service_requested":null,"service_duration_mins":60,"proposed_datetime":null,"zone_ok":true,"reply":"your plain text reply here"}`;

  const response = await anthropic.messages.create({ model: "claude-haiku-4-5-20251001", max_tokens: 1500, messages: [{ role: "user", content: prompt }] });
  let raw = response.content[0].text.replace(/```json|```/g,"").trim();
  
  // Limpiar caracteres de control y saltos de línea no escapados dentro del JSON
  try {
    return JSON.parse(raw);
  } catch(e) {
    // Si falla, intentar escapar saltos de línea en el campo "reply"
    raw = raw.replace(/"reply":\s*"([\s\S]*?)"\s*}/, (match, replyContent) => {
      const escaped = replyContent.replace(/\n/g, "\\n").replace(/\r/g, "");
      return `"reply": "${escaped}"}`;
    });
    return JSON.parse(raw);
  }
}

async function processMessage(text, appointments) {
  const a = await analyzeMessage(text, appointments);
  // NO agendar automaticamente - solo Diana confirma despues del pago
  return a;
}

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
    const imap = getImap(); const results = [];
    imap.once("ready", () => {
      imap.openBox("INBOX", false, (err) => {
        if (err) return reject(err);
        imap.search(["UNSEEN"], (err, uids) => {
          if (err) return reject(err);
          if (!uids || uids.length===0) { imap.end(); return resolve([]); }
          const fetch = imap.fetch(uids.slice(0,5), { bodies: "", markSeen: true });
          fetch.on("message", (msg) => {
            let buf = "";
            msg.on("body", (stream) => { stream.on("data", c => buf+=c.toString("utf8")); stream.once("end", async () => { const p = await simpleParser(buf); results.push({ from: p.from?.text||"", replyTo: p.replyTo?.text||p.from?.text||"", subject: p.subject||"", body: p.text||"" }); }); });
          });
          fetch.once("end", () => { setTimeout(()=>{ imap.end(); resolve(results); }, 1000); });
        });
      });
    });
    imap.once("error", reject);
    imap.connect();
  });
}

async function sendReply(to, subject, replyText) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
  const fullText = `${replyText}\n\n---\n"Pamper Me" Mobile Nails & Spa\n📱 215-490-1515\n🌐 pampermemobilenails.com`;
  const subj = subject.startsWith("Re:") ? subject : `Re: ${subject}`;
  
  // Enviar con SendGrid desde el correo corporativo
  await sgMail.send({
    to,
    from: { email: "agent@pampermemobilenails.com", name: "\"Pamper Me\" Mobile Nails & Spa ✨" },
    replyTo: "agent@pampermemobilenails.com",
    subject: subj,
    text: fullText,
  });

  // Guardar copia en Gmail Sent del correo corporativo
  try {
    const auth = getGoogleAuth();
    const gmail = google.gmail({ version: "v1", auth });
    const raw = Buffer.from(
      `From: Pamper Me Mobile Nails <agent@pampermemobilenails.com>\nTo: ${to}\nSubject: ${subj}\nContent-Type: text/plain; charset=utf-8\n\n${fullText}`
    ).toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
    await gmail.users.messages.insert({
      userId: "me",
      resource: { raw, labelIds: ["SENT"] },
    });
    console.log(`📁 Copia guardada en Gmail Sent`);
  } catch(gmailErr) {
    console.error("⚠️ No se pudo guardar copia en Gmail:", gmailErr.message);
  }
}

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
      await twilioClient.messages.create({ from: process.env.TWILIO_PHONE_NUMBER, to: caller, body: `✅ Pamper Me: Appointment confirmed! 💅 ${a.service_requested||"Nail Service"} at ${a.detected_address}. Questions: 215-490-1515` });
    }
  } catch(err) { twiml.say({ voice: "Polly.Joanna" }, "Sorry, please text 215-490-1515 to book."); }
  res.type("text/xml").send(twiml.toString());
});

async function checkYahooMail() {
  try {
    const emails = await getUnreadEmails();
    if (emails.length===0) { console.log("📭 No hay correos nuevos"); return; }
    console.log(`📧 ${emails.length} correo(s) nuevo(s) en Yahoo`);
    const appts = await getUpcomingAppointments().catch(()=>{ console.log("⚠️ Calendar no disponible"); return []; });
    // Lista de remitentes a ignorar (sistemas, no clientes)
    const IGNORE_SENDERS = [
      "no-reply@accounts.google.com",
      "noreply@github.com",
      "hello@notify.railway.app",
      "reply@railway.app",
      "noreply@",
      "no-reply@",
      "donotreply@",
      "mailer-daemon@",
      "postmaster@"
    ];

    for (const email of emails) {
      try {
        // Ignorar correos del sistema
        const fromLower = (email.from || "").toLowerCase();
        if (IGNORE_SENDERS.some(s => fromLower.includes(s))) {
          console.log(`⏭️ Correo del sistema ignorado: ${email.from}`);
          continue;
        }

        // Crear ID único para este correo
        const emailId = `${email.from}-${email.subject}-${(email.body||"").substring(0,50)}`;
        
        // Verificar si ya fue procesado
        if (processedEmails.has(emailId)) {
          console.log(`⏭️ Correo ya procesado, saltando: ${email.from}`);
          continue;
        }
        
        // Marcar como procesado
        processedEmails.add(emailId);
        
        // Guardar en disco para sobrevivir reinicios
        saveProcessedEmails(processedEmails);

        console.log(`📨 Procesando de: ${email.from}`);
        const body = email.body||email.subject||"";
        console.log(`📝 Contenido: ${body.substring(0,100)}`);
        const a = await processMessage(body, appts);
        console.log(`🤖 Respuesta lista: ${a.reply.substring(0,50)}`);
        
        // Si es formulario de Squarespace, responder al EMAIL del cliente
        let to = email.replyTo||email.from;
        if (a.client_email) {
          to = a.client_email;
          console.log(`📋 Formulario Squarespace detectado, respondiendo a cliente: ${to}`);
        }
        
        // Si es promocional, no responder
        if (a.reply && a.reply.includes("IGNORE_PROMO")) {
          console.log(`⏭️ Correo promocional ignorado: ${email.from}`);
          continue;
        }

        // Verificar si ya respondimos a este cliente recientemente (24 horas)
        const lastSent = sentResponses.get(to);
        const now = Date.now();
        if (lastSent && (now - lastSent) < 24 * 60 * 60 * 1000) {
          const horasAtras = Math.floor((now - lastSent) / (60 * 60 * 1000));
          console.log(`⏭️ Ya respondimos a ${to} hace ${horasAtras}h, saltando`);
          continue;
        }

        console.log(`📤 Enviando a: ${to}`);
        await sendReply(to, email.subject, a.reply);
        console.log(`✉️ Respuesta enviada a ${to}`);
        
        // Registrar el envío
        sentResponses.set(to, now);
        saveSentResponses(sentResponses);
        
        // Enviar aviso urgente a Diana SOLO si tiene toda la info completa
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
          console.log(`🔔 Aviso urgente enviado a Diana por email`);

          // Crear evento urgente en Google Calendar
          try {
            const auth = getGoogleAuth();
            const calendar = google.calendar({ version: "v3", auth });
            const now = new Date();
            const eventStart = new Date(now.getTime() + 2 * 60000); // 2 minutos desde ahora
            const eventEnd = new Date(now.getTime() + 17 * 60000); // 15 minutos de duración
            
            await calendar.events.insert({
              calendarId: "primary",
              resource: {
                summary: `🚨 REVISAR SOLICITUD (NO ES CITA) - ${a.client_name || "Cliente"}`,
                description: `ESTO ES SOLO UN AVISO - LA CITA NO ESTÁ CONFIRMADA\n\nACCION REQUERIDA POR DIANA:\n\nCliente: ${a.client_name || "No especificado"}\nEmail: ${a.client_email || to}\nDireccion: ${a.detected_address || "No especificada"}\nServicio: ${a.service_requested || "No especificado"}\nFecha solicitada: ${a.proposed_datetime || "Por confirmar"}\n\nPASOS:\n1. Revisar la solicitud\n2. Confirmar travel fee al cliente\n3. Enviar link de pago (50% deposito)\n4. SOLO después del pago - agendar la cita real en Calendar`,
                start: { dateTime: eventStart.toISOString(), timeZone: "America/New_York" },
                end: { dateTime: eventEnd.toISOString(), timeZone: "America/New_York" },
                reminders: {
                  useDefault: false,
                  overrides: [
                    { method: "popup", minutes: 0 },
                  ],
                },
              },
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
  } catch(err) { console.error("❌ Yahoo check:", err.message, err.stack); }
}

setInterval(checkYahooMail, 5 * 60 * 1000);

app.get("/", (req, res) => res.send("<h2>💅 Pamper Me Agent — Active</h2><p>Correos procesados: " + processedEmails.size + "</p><p><a href='/stats'>Ver estadísticas</a> | <a href='/sent'>Respuestas enviadas</a></p>"));

// CORS para el widget de chat
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// Endpoint para chat widget en la web
app.post("/chat", async (req, res) => {
  try {
    const { message, history } = req.body;
    if (!message) return res.json({ reply: "Por favor escribe un mensaje." });

    console.log(`💬 Chat web: ${message}`);

    // Construir contexto con historial
    const fullMessage = history && history.length > 0
      ? `Conversación previa:\n${history.map(h => `${h.role}: ${h.text}`).join("\n")}\n\nNuevo mensaje: ${message}`
      : message;

    const a = await processMessage(fullMessage, []);
    
    // Si el cliente dio info completa, avisar a Diana
    if (a.appointment_requested && !a.acrylic_requested && !a.out_of_coverage && 
        a.detected_address && a.service_requested && a.client_name) {
      try {
        const alert = `🚨 NUEVA SOLICITUD DESDE EL CHAT WEB 🚨

Cliente: ${a.client_name}
Email: ${a.client_email || "No proporcionado"}
Dirección: ${a.detected_address}
Servicio: ${a.service_requested}
Fecha solicitada: ${a.proposed_datetime || "Por confirmar"}

ACCIÓN REQUERIDA:
1. Confirmar el costo del travel fee
2. Enviar link de pago al cliente (50% deposito)
3. Confirmar la cita

--- Chat Widget Pamper Me ---`;

        await sendReply("agent@pampermemobilenails.com", "🚨 NUEVA SOLICITUD DESDE CHAT WEB", alert);
        console.log(`🔔 Aviso desde chat enviado a Diana`);
      } catch(alertErr) {
        console.error("⚠️ Error enviando alerta:", alertErr.message);
      }
    }

    res.json({ reply: a.reply });
  } catch(err) {
    console.error("❌ Chat error:", err.message);
    res.json({ reply: "Disculpa, tuve un problema técnico. Por favor escríbenos a agent@pampermemobilenails.com" });
  }
});

app.get("/sent", (req, res) => {
  const entries = Array.from(sentResponses.entries()).sort((a,b) => b[1] - a[1]).slice(0, 50);
  const list = entries.map(([email, timestamp]) => {
    const date = new Date(timestamp).toLocaleString("es-ES", { timeZone: "America/New_York" });
    return `<li>${email} - ${date}</li>`;
  }).join("");
  res.send(`<h2>📤 Últimas respuestas enviadas (${sentResponses.size})</h2><ul>${list}</ul><p><a href='/'>Volver</a></p>`);
});

app.get("/stats", (req, res) => {
  const list = Array.from(processedEmails).map(id => {
    const parts = id.split("-");
    return `<li>${parts[0]} | ${parts[1] || ""}</li>`;
  }).reverse().slice(0, 50).join("");
  res.send(`<h2>📊 Últimos correos procesados (${processedEmails.size})</h2><ul>${list}</ul><p><a href='/'>Volver</a></p>`);
});

app.get("/reset", (req, res) => {
  processedEmails.clear();
  saveProcessedEmails(processedEmails);
  res.send("<h2>✅ Lista de procesados limpiada</h2>");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Pamper Me Agent running on port ${PORT}`);
  console.log(`📧 Checking Yahoo Mail every 5 minutes...`);
  checkYahooMail();
});
