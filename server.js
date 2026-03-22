const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const { createClient } = require("@supabase/supabase-js");

const SETTINGS_PATH = path.join(__dirname, "data", "settings.json");
const OPENROUTER_DEFAULT_MODEL =
  process.env.OPENROUTER_MODEL || "openai/gpt-oss-120b:free";
const OPENROUTER_REFERER_FALLBACK = "https://ponizov-geo.ru";
const OPENROUTER_TITLE_FALLBACK = "Ponizov Geo - Yandex Maps text helper";

const openRouterSdkPromise = import("@openrouter/sdk");

/** Fetch требует ByteString в заголовках: только U+0000–U+00FF. */
function latin1HeaderValue(raw, fallback) {
  const s = raw == null ? "" : String(raw).trim();
  if (!s) return fallback;
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c <= 0xff) out += s[i];
  }
  out = out.trim();
  return out || fallback;
}

function safeOpenRouterReferer(raw) {
  const trimmed = raw == null ? "" : String(raw).trim();
  if (!trimmed) return OPENROUTER_REFERER_FALLBACK;
  try {
    return new URL(trimmed).href;
  } catch {
    return OPENROUTER_REFERER_FALLBACK;
  }
}

function parseCommaList(envVal) {
  if (envVal == null || !String(envVal).trim()) return null;
  const parts = String(envVal)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length ? parts : null;
}

function openRouterProviderPrefs(modelId) {
  const order = parseCommaList(process.env.OPENROUTER_PROVIDER_ORDER);
  const only = parseCommaList(process.env.OPENROUTER_PROVIDER_ONLY);
  const ignore = parseCommaList(process.env.OPENROUTER_PROVIDER_IGNORE);
  if (order || only || ignore) {
    const p = {};
    if (order) p.order = order;
    if (only) p.only = only;
    if (ignore) p.ignore = ignore;
    return p;
  }
  const off = process.env.OPENROUTER_PREFER_OPENAI === "0" || process.env.OPENROUTER_PREFER_OPENAI === "false";
  const mid = String(modelId || "");
  if (!off && mid.startsWith("openai/") && !mid.includes(":free")) {
    return { order: ["OpenAI"] };
  }
  if (process.env.OPENROUTER_PREFER_OPENAI === "1" || process.env.OPENROUTER_PREFER_OPENAI === "true") {
    return { order: ["OpenAI"] };
  }
  return null;
}

function explainOpenRouterError(message) {
  let m = String(message || "");
  if (/Insufficient credits|never purchased credits/i.test(m)) {
    m +=
      " Войдите в аккаунт OpenRouter, к которому привязан этот API-ключ, и пополните баланс: https://openrouter.ai/settings/credits — без покупки кредитов запросы к API обычно блокируются, в том числе к бесплатным моделям.";
  }
  if (/No allowed providers|guardrail|data policy/i.test(m)) {
    m +=
      " Модель: " +
      OPENROUTER_DEFAULT_MODEL +
      ". Для :free моделей часто нужны другие провайдеры или смягчение privacy / allowlist в OpenRouter.";
  }
  return m;
}

function readSettings() {
  try {
    const raw = fs.readFileSync(SETTINGS_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function writeSettings(obj) {
  const dir = path.dirname(SETTINGS_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(obj, null, 2), "utf8");
}

function getOpenrouterKey() {
  const env = process.env.OPENROUTER_API_KEY;
  if (env && String(env).trim()) return String(env).trim();
  const s = readSettings();
  const k = s.openrouterApiKey;
  return k && String(k).trim() ? String(k).trim() : "";
}

const app = express();
const PORT = process.env.PORT || 3002;

// Supabase
const SUPABASE_URL = process.env.SUPABASE_URL || "https://sbexbkdgomzkzaovbhbq.supabase.co";
const SUPABASE_KEY =
  process.env.SUPABASE_KEY ||
  "sb_publishable_GRGC_MNHItTAPDNa4EfdnA_KRc-hIne";

// Telegram
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "8689129494:AAEWlQV9D_J_zCi-2TSeEqawn8kUEaoNes0";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "283522178";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function sendToTelegram(name, phone, message) {
  const text = `Новая заявка!\nИмя: ${name}\nТелефон: ${phone}\nСообщение: ${message}`;
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text }),
    });
    if (!res.ok) {
      console.error("Telegram API ошибка:", res.status, await res.text());
    }
  } catch (err) {
    console.error("Ошибка отправки в Telegram:", err.message);
  }
}

app.use(cors());
app.use(express.json());

// Сначала API — чтобы POST /api/* не пересекался со статикой и не отдавались чужие 405 от фронта
app.post("/api/lead", async (req, res) => {
  try {
    const { name, phone, message } = req.body || {};

    if (!name || !phone || !message) {
      console.error("Ошибка: неполные данные заявки", { name, phone, message });
      return res.status(400).json({
        success: false,
        error: "Необходимо указать имя, телефон и сообщение",
      });
    }

    console.log("Новая заявка:", { name, phone, message });

    const { error } = await supabase.from("leads").insert([
      {
        name,
        phone,
        message,
        status: "new",
      },
    ]);

    if (error) {
      console.error("Ошибка сохранения заявки в Supabase:", error);
      return res.status(500).json({
        success: false,
        error: "Не удалось сохранить заявку",
      });
    }

    res.json({ success: true });

    sendToTelegram(name, phone, message).catch((err) =>
      console.error("Telegram:", err.message)
    );
  } catch (err) {
    console.error("Необработанная ошибка в /api/lead:", err);
    res.status(500).json({
      success: false,
      error: "Внутренняя ошибка сервера",
    });
  }
});

app.get("/api/leads", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("leads")
      .select("id, name, phone, message, status, created_at")
      .order("created_at", { ascending: false });

    if (error) {
      console.error("Ошибка загрузки заявок:", error);
      return res.status(500).json({
        success: false,
        error: "Не удалось загрузить заявки",
      });
    }

    res.json(data || []);
  } catch (err) {
    console.error("Необработанная ошибка в GET /api/leads:", err);
    res.status(500).json({
      success: false,
      error: "Внутренняя ошибка сервера",
    });
  }
});

// Настройки (ключ OpenRouter хранится в data/settings.json или в OPENROUTER_API_KEY)
app.get("/api/settings", (req, res) => {
  try {
    const key = getOpenrouterKey();
    res.json({
      openrouterConfigured: !!key,
      openrouterKeyHint: key && key.length >= 4 ? "…" + key.slice(-4) : key ? "…" : null,
      openrouterModel: OPENROUTER_DEFAULT_MODEL,
    });
  } catch (err) {
    console.error("GET /api/settings:", err);
    res.status(500).json({ error: "Не удалось прочитать настройки" });
  }
});

app.put("/api/settings", (req, res) => {
  try {
    const { openrouterApiKey } = req.body || {};
    if (openrouterApiKey === undefined) {
      return res.status(400).json({ error: "Укажите поле openrouterApiKey (строка или пустая для сброса файла)" });
    }
    const settings = readSettings();
    if (openrouterApiKey === null || String(openrouterApiKey).trim() === "") {
      delete settings.openrouterApiKey;
      writeSettings(settings);
      const still = !!process.env.OPENROUTER_API_KEY;
      return res.json({
        success: true,
        openrouterConfigured: still,
        openrouterKeyHint: still ? "из переменной окружения" : null,
        message: still
          ? "Ключ из файла удалён; используется OPENROUTER_API_KEY из окружения."
          : "Ключ удалён из файла.",
      });
    }
    settings.openrouterApiKey = String(openrouterApiKey).trim();
    writeSettings(settings);
    const k = settings.openrouterApiKey;
    res.json({
      success: true,
      openrouterConfigured: true,
      openrouterKeyHint: k.length >= 4 ? "…" + k.slice(-4) : "…",
    });
  } catch (err) {
    console.error("PUT /api/settings:", err);
    res.status(500).json({ error: "Не удалось сохранить настройки" });
  }
});

// Генерация текста через OpenRouter (ключ только на сервере).
// Дублирующий путь /ponizov-gt — если nginx/CDN отдаёт 405 на POST /api/*.
async function handleOpenRouterGenerate(req, res, routeLabel) {
  const apiKey = getOpenrouterKey();
  if (!apiKey) {
    return res.status(503).json({
      error:
        "Генерация недоступна: не задан ключ OpenRouter. Добавьте его в админ-панели или переменную окружения OPENROUTER_API_KEY.",
    });
  }

  const { prompt, task } = req.body || {};
  const userText = String(prompt || task || "").trim();
  if (!userText) {
    return res.status(400).json({ error: "Введите запрос (поле prompt)" });
  }
  if (userText.length > 12000) {
    return res.status(400).json({ error: "Запрос слишком длинный (макс. 12000 символов)" });
  }

  const systemPrompt =
    "Ты помощник по текстам для Яндекс.Карт и локального бизнеса в России. Пиши по-русски, по делу, без лишней воды. Если уместно — используй короткие абзацы и списки.";

  try {
    const { OpenRouter } = await openRouterSdkPromise;
    const openrouter = new OpenRouter({
      apiKey,
      httpReferer: safeOpenRouterReferer(process.env.SITE_URL),
      xTitle: latin1HeaderValue(process.env.OPENROUTER_X_TITLE, OPENROUTER_TITLE_FALLBACK),
    });

    const providerPrefs = openRouterProviderPrefs(OPENROUTER_DEFAULT_MODEL);
    const chatParams = {
      model: OPENROUTER_DEFAULT_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userText },
      ],
      stream: true,
    };
    if (providerPrefs) chatParams.provider = providerPrefs;

    const stream = await openrouter.chat.send({
      chatGenerationParams: chatParams,
    });

    let text = "";
    for await (const chunk of stream) {
      if (chunk.error?.message) {
        console.error("OpenRouter chunk error:", chunk.error);
        return res
          .status(502)
          .json({ error: explainOpenRouterError(chunk.error.message) });
      }
      const delta = chunk.choices?.[0]?.delta;
      const part = delta?.content;
      if (part) text += part;
    }

    text = String(text).trim();
    if (!text) {
      return res.status(502).json({ error: "Пустой ответ модели" });
    }

    res.json({ text });
  } catch (err) {
    let msg =
      err && typeof err.message === "string" && err.message.trim()
        ? err.message
        : "Ошибка сети или сервера при обращении к OpenRouter";
    msg = explainOpenRouterError(msg);
    const code = err && typeof err.statusCode === "number" ? err.statusCode : null;
    const httpStatus =
      code !== null && code >= 400 && code < 600 ? code : 500;
    console.error(routeLabel || "POST generate:", err);
    res.status(httpStatus).json({ error: msg });
  }
}

app.post("/api/generate-text", (req, res) =>
  handleOpenRouterGenerate(req, res, "POST /api/generate-text")
);
app.post("/ponizov-gt", (req, res) =>
  handleOpenRouterGenerate(req, res, "POST /ponizov-gt")
);

app.patch("/api/leads/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const { status } = req.body || {};

    if (!id) {
      return res.status(400).json({ success: false, error: "Нет id" });
    }

    const updates = {};
    if (status !== undefined) updates.status = status;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ success: false, error: "Нет полей для обновления" });
    }

    const { data, error } = await supabase
      .from("leads")
      .update(updates)
      .eq("id", id)
      .select()
      .single();

    if (error) {
      console.error("Ошибка обновления заявки:", error);
      return res.status(500).json({
        success: false,
        error: "Не удалось обновить заявку",
      });
    }

    res.json(data);
  } catch (err) {
    console.error("Необработанная ошибка в PATCH /api/leads/:id:", err);
    res.status(500).json({
      success: false,
      error: "Внутренняя ошибка сервера",
    });
  }
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.use(express.static(__dirname));

app.listen(PORT, () => {
  console.log("Сервер запущен на http://localhost:" + PORT);
});
