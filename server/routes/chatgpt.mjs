import express from "express";
import openai from "openai";
import jimp from "jimp";
import crypto from "crypto";

const CHAT_KEY = "ti84/chat/db.json";
const DAY_MS = 24 * 60 * 60 * 1000;

// LLM endpoint config. Works with any OpenAI-compatible API (OpenRouter, Groq,
// Together, DeepSeek, a self-hosted proxy, etc.). Leave OPENAI_BASE_URL unset to
// use OpenAI directly. Values are trimmed because Vercel env vars can carry
// stray trailing newlines.
const LLM_BASE_URL = (process.env.OPENAI_BASE_URL || "").trim() || undefined;
// One model for general/chat/vision, an optional stronger one for the math solver.
// If only LLM_MODEL is set, the math solver uses it too.
const LLM_MODEL = (process.env.LLM_MODEL || "").trim() || "gpt-5.4-nano";
const LLM_MODEL_MATH =
  (process.env.LLM_MODEL_MATH || "").trim() ||
  (process.env.LLM_MODEL || "").trim() ||
  "gpt-5.4";

// Persistent memory store while Render is running
const memoryDb = { conversations: {} };

async function readDb() {
  return memoryDb;
}
async function writeDb(data) {
  // Retained automatically in memoryDb
}

export async function chatgpt() {
  const routes = express.Router();

  // Lazy-init so a missing/invalid OPENAI_API_KEY only breaks /gpt routes,
  // not firmware OTA / programs / the rest of the server.
  let _gpt;
  const getGpt = () =>
    (_gpt ??= new openai.OpenAI({
      baseURL: LLM_BASE_URL,
      apiKey: (process.env.OPENAI_API_KEY || "").trim(),
    }));

  // System prompt allowing brief, clear explanations formatted for TI-84 display
  const baseSystemPrompt =
    "You are a helpful AI assistant on a TI-84 calculator. " +
    "Follow all user instructions directly. When explaining questions or math problems, give clear, concise step-by-step explanations without unnecessary length. " +
    "Use UPPERCASE letters only. NEVER use LaTeX, backslashes, double quotes, or curly braces. " +
    "Write fractions as A/B, exponents as X^N, pi as PI, and sqrt as SQRT().";

  routes.get("/ask", async (req, res) => {
    const question = req.query.question ?? "";
    if (Array.isArray(question)) {
      res.sendStatus(400);
      return;
    }

    const hasSid = "sid" in req.query;

    try {
      // Stateless mode (derivative, translate, etc.)
      if (!hasSid) {
        const isMath = "math" in req.query;
        const systemPrompt = isMath
          ? "You are a precise math solver for a TI-84 calculator. Provide the answer with a brief, concise step-by-step explanation. Use UPPERCASE. NEVER use LaTeX, backslashes, or curly braces. Write fractions as A/B, exponents as X^N, pi as PI, sqrt as SQRT()."
          : baseSystemPrompt;

        const result = await getGpt().chat.completions.create({
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: question },
          ],
          model: isMath ? LLM_MODEL_MATH : LLM_MODEL,
          max_tokens: 1000,
        });

        let answer = result.choices[0]?.message?.content ?? "NO RESPONSE";
        answer = answer
          .replace(/[\r\n]+/g, " ")
          .replace(/["\\]/g, "")
          .toUpperCase();

        res.send(answer);
        return;
      }

      // Chat mode with session
      const data = await readDb();

      // Cleanup old conversations
      const now = Date.now();
      for (const [id, conv] of Object.entries(data.conversations)) {
        if (now - conv.created > DAY_MS) delete data.conversations[id];
      }

      let sessionId = req.query.sid;
      let history = [];

      if (sessionId && data.conversations[sessionId]) {
        history = data.conversations[sessionId].messages;
      } else {
        sessionId = crypto.randomBytes(4).toString("hex");
        data.conversations[sessionId] = { created: now, messages: [] };
      }

      const messages = [
        { role: "system", content: baseSystemPrompt },
        ...history.slice(-10),
        { role: "user", content: question },
      ];

      const result = await getGpt().chat.completions.create({ 
        messages, 
        model: LLM_MODEL,
        max_tokens: 1000 
      });

      let answer = result.choices[0]?.message?.content ?? "NO RESPONSE";

      // Remove raw line breaks and forbidden characters that freeze TI-BASIC
      answer = answer
        .replace(/[\r\n]+/g, " ")
        .replace(/["\\]/g, "")
        .toUpperCase();

      data.conversations[sessionId].messages.push(
        { role: "user", content: question },
        { role: "assistant", content: answer }
      );
      await writeDb(data);

      res.send(`${sessionId}|${answer}`);
    } catch (e) {
      console.error(e);
      res.sendStatus(500);
    }
  });

  routes.get("/history", async (req, res) => {
    const sid = req.query.sid ?? "";
    const page = parseInt(req.query.p ?? "0");

    if (!sid) {
      res.status(400).send("NO SESSION");
      return;
    }

    const data = await readDb();
    const conv = data.conversations[sid];
    if (!conv) {
      res.send("0/0|NO HISTORY");
      return;
    }

    const totalPairs = Math.floor(conv.messages.length / 2);
    if (page < 0 || page >= totalPairs) {
      res.send(`${page}/${totalPairs}|NO MORE`);
      return;
    }

    const q = conv.messages[page * 2].content.substring(0, 80);
    const a = conv.messages[page * 2 + 1].content.substring(0, 150);
    res.send(`${page}/${totalPairs}|Q:${q} A:${a}`);
  });

  // Solve a math equation from an uploaded image (in-memory, no disk write).
  routes.post("/solve", async (req, res) => {
    try {
      const contentType = req.headers["content-type"];
      if (contentType !== "image/jpg") {
        res.status(400).send(`bad content-type: ${contentType}`);
        return;
      }

      const image = await jimp.read(req.body);
      const jpegBuffer = await image.getBufferAsync(jimp.MIME_JPEG);
      const encoded_image = jpegBuffer.toString("base64");

      const question_number = req.query.n;
      const question = question_number
        ? `What is the answer to question ${question_number}?`
        : "What is the answer to this question?";

      const result = await getGpt().chat.completions.create({
        messages: [
          {
            role: "system",
            content:
              "You are a helpful math tutor. Answer the math question accurately from the image with a concise explanation. Keep it brief and to the point.",
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `${question} Provide a brief concise explanation for the answer. If the question is multiple-choice, give the letter answer followed by the brief reason.`,
              },
              { type: "image_url", image_url: { url: `data:image/jpeg;base64,${encoded_image}`, detail: "high" } },
            ],
          },
        ],
        model: LLM_MODEL,
        max_tokens: 1000,
      });

      res.send(result.choices[0]?.message?.content ?? "no response");
    } catch (e) {
      console.error(e);
      res.sendStatus(500);
    }
  });

  return routes;
}
