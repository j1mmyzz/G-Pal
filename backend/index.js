import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { OAuth2Client } from "google-auth-library";
import OpenAI from "openai";
import { google } from "googleapis";

dotenv.config();

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const oauth2Client = new OAuth2Client(
  process.env.CLIENT_ID,
  process.env.CLIENT_SECRET,
  process.env.REDIRECT_URI
);

//gcal
const calendar = google.calendar({ version: "v3", auth: oauth2Client });

const app = express();
app.use(cors());
app.use(express.json());

app.post("/chat", async (req, res) => {
  try {
    const message = req.body.message;
    const today = new Date().toLocaleDateString("en-CA", {
      timeZone: "America/New_York",
    });

    const prompt = `
You are G-Pal, an AI assistant that converts natural language into Google Calendar actions.

Your only job is to analyze the user's message and produce a structured JSON command for the backend.

--------------------
📌 OUTPUT RULES
--------------------
1. You MUST return ONLY valid JSON. No explanations. No extra text.
2. Never include trailing commas.
3. If a field is unknown, make it an empty string ("").
4. If the message is unrelated to scheduling, use: { "action": "none", ... }

--------------------
📌 ACTION TYPES
--------------------
"add", "update", "delete", "check", "list", "move", "none"

--------------------
📌 REQUIRED JSON FORMAT
--------------------
{
  "action": "",
  "title": "",
  "start": "",
  "end": "",
  "date": "",
  "details": "",
  "target_event": ""
}

--------------------
📌 TODAY'S DATE
--------------------
Today's date is: ${today}
Use this to resolve "today", "tomorrow", "this Monday", etc. into exact ISO dates.

--------------------
📌 DATE & TIME RULES
--------------------
Resolve natural language time like:
"tomorrow at 3", "next Friday", "later today", "from 4 to 6", "in two hours", etc.

--------------------
📌 DATE RESOLUTION RULES (CRITICAL)
--------------------
If the user specifies ONLY a time (ex: "at 11", "at 12pm"):

- If the time has NOT passed yet today → use TODAY.
- If the time HAS passed → use TOMORROW.

Example:
• It is currently 3pm → "at 11am" means TOMORROW.
• It is currently 8am → "at 11am" means TODAY.

You MUST always include a full date (YYYY-MM-DD) when returning "start".
Never return a time without a date.

--------------------
📌 NOW PROCESS THE USER MESSAGE:
--------------------
Message: "${message}"
`;

    const completion = await client.responses.create({
      model: "gpt-4.1-mini",
      input: prompt,
    });

    const output = completion.output_text;
    console.log("Raw AI output:", output);

    let command;
    try {
      command = JSON.parse(output);
    } catch (e) {
      console.error("Failed to parse AI JSON:", e);
      return res.status(500).json({
        reply: "I couldn't understand that request. Please rephrase.",
      });
    }

    let replyMessage = "";
    let eventData = null;

    if (command.action === "add") {
      try {
        eventData = await createEventFromCommand(command);
        replyMessage = `Created event "${eventData.summary}" on ${
          eventData.start.dateTime || eventData.start.date
        }.`;
      } catch (err) {
        console.error("Calendar error:", err);
        replyMessage =
          "I understood your request but couldn't create the event. Is Google Calendar connected?";
      }
    } else if (command.action === "delete") {
      try {
        const eventId = await findEventIdByTitle(command.target_event);

        if (!eventId) {
          replyMessage = `I couldn't find an event named "${command.target_event}".`;
        } else {
          await deleteEventById(eventId);
          replyMessage = `Deleted event "${command.target_event}".`;
        }
      } catch (err) {
        console.error(err);
        replyMessage =
          "I understood the delete request but couldn't remove the event.";
      }
    } else if (command.action === "move") {
      try {
        const result = await moveEvent(command);

        if (!result.success) {
          replyMessage = `I couldn't find an event named "${command.target_event}".`;
        } else {
          replyMessage = `Moved "${command.target_event}" to ${
            result.event.start.dateTime || result.event.start.date
          }.`;
        }
      } catch (err) {
        console.error(err);
        replyMessage =
          "I understood the move request but couldn't move the event.";
      }
    } else {
      replyMessage = "I don't understand the request.";
    }

    res.json({ reply: replyMessage, command, event: eventData });
  } catch (error) {
    console.error("AI error:", error);
    res.status(500).json({ reply: "Error processing AI request." });
  }
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
});

app.get("/auth/google", (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: ["https://www.googleapis.com/auth/calendar"],
    prompt: "consent",
  });

  res.redirect(url);
});

app.get("/auth/google/callback", async (req, res) => {
  const code = req.query.code;

  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);

  global.googleTokens = tokens;

  res.send(`
  <html>
    <head>
      <title>G-Pal Connected</title>
      <style>
        body {
          font-family: Arial, sans-serif;
          background-color: #f5f7fa;
          display: flex;
          justify-content: center;
          align-items: center;
          height: 100vh;
          margin: 0;
          color: #333;
        }
        .container {
          background: white;
          padding: 30px;
          border-radius: 12px;
          box-shadow: 0 4px 12px rgba(0,0,0,0.1);
          text-align: center;
          width: 350px;
        }
        h1 {
          margin-bottom: 10px;
          font-size: 24px;
          color: #7accf5;
        }
        p {
          font-size: 16px;
          margin-bottom: 20px;
        }
      </style>
    </head>

    <body>
    
      <div class="container">
        <h1>G-Pal Connected!!</h1>
        <p>Your Google Calendar is now linked.<br>You may close this tab.</p>
      </div>
    </body>
  </html>
`);
});

app.get("/auth/status", (req, res) => {
  const isConnected = !!global.googleTokens?.access_token;
  res.json({ connected: isConnected });
});

async function createEventFromCommand(command) {
  if (!global.googleTokens?.access_token) {
    throw new Error("Google Calendar is not connected.");
  }

  oauth2Client.setCredentials(global.googleTokens);

  // Use EST (fix timezone issue)
  const timeZone = "America/New_York";

  let startDateTime = command.start;
  let endDateTime = command.end;

  // --- FIXED TIME HANDLING ----

  function normalize(ts) {
    if (!ts) return ts;
    ts = ts.trim();

    // Add seconds if missing (T11:00 → T11:00:00)
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(ts)) {
      ts += ":00";
    }

    // Add EST offset if missing
    if (!/[+-]\d{2}:\d{2}$/.test(ts)) {
      ts += "-05:00";
    }

    return ts;
  }

  // If only a date is given → default to 9 AM
  if (!startDateTime && command.date) {
    startDateTime = `${command.date}T09:00:00-05:00`;
  }

  // If end missing → default to 1 hour after start
  if (!endDateTime && startDateTime) {
    const startLocal = new Date(normalize(startDateTime));
    const endLocal = new Date(startLocal.getTime() + 60 * 60 * 1000);

    endDateTime = endLocal.toISOString().slice(0, 19);
  }

  startDateTime = normalize(startDateTime);
  endDateTime = normalize(endDateTime);

  if (!startDateTime || !endDateTime) {
    throw new Error("Missing start/end time for event.");
  }

  const event = {
    summary: command.title || "Untitled event",
    description: command.details || "",
    start: { dateTime: startDateTime, timeZone },
    end: { dateTime: endDateTime, timeZone },
  };

  const response = await calendar.events.insert({
    calendarId: "primary",
    requestBody: event,
  });

  return response.data;
}

async function findEventIdByTitle(title) {
  if (!title) return null;

  oauth2Client.setCredentials(global.googleTokens);

  const response = await calendar.events.list({
    calendarId: "primary",
    timeMin: new Date(Date.now() - 1000 * 60 * 60 * 24 * 7).toISOString(), // last 7 days
    timeMax: new Date(Date.now() + 1000 * 60 * 60 * 24 * 14).toISOString(), // next 14 days
    maxResults: 50,
    singleEvents: true,
    orderBy: "startTime",
  });

  const events = response.data.items || [];
  const clean = (s) => s.toLowerCase().trim();

  const target = clean(title);

  let match = events.find((e) => clean(e.summary) === target);
  if (match) return match.id;

  match = events.find((e) => clean(e.summary).includes(target));
  if (match) return match.id;

  console.log(
    "Events searched:",
    events.map((e) => e.summary)
  );
  return null;
}

async function deleteEventById(eventId) {
  oauth2Client.setCredentials(global.googleTokens);

  await calendar.events.delete({
    calendarId: "primary",
    eventId,
  });

  return true;
}

async function moveEvent(command) {
  // Check connection
  if (!global.googleTokens?.access_token) {
    throw new Error("Google Calendar is not connected.");
  }

  oauth2Client.setCredentials(global.googleTokens);

  // Step 1 — Find event to move
  const eventId = await findEventIdByTitle(command.target_event);

  if (!eventId) {
    return { success: false, error: "Event not found." };
  }

  // Step 2 — Delete old event
  await deleteEventById(eventId);

  // Step 3 — Create new event at new location/time
  const eventData = await createEventFromCommand(command);

  return { success: true, event: eventData };
}
