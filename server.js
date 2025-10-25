import fs from "fs";
import path from "path";
import express from "express";
import fetch from "node-fetch";
import { createProxyMiddleware } from "http-proxy-middleware";
import events from "events";
events.EventEmitter.defaultMaxListeners = 1000000000000000000000;

const app = express();
const PORT = process.env.PORT || 8080;
app.use(express.json());

// =============================
// 🔐 SEGURIDAD ADMIN PANEL
// =============================
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "you120";

app.use("/admin", (req, res, next) => {
  const authHeader = req.headers.authorization || "";
  const [type, credentials] = authHeader.split(" ");

  if (type === "Basic" && credentials) {
    const [user, pass] = Buffer.from(credentials, "base64").toString().split(":");
    if (user === ADMIN_USER && pass === ADMIN_PASS) {
      return next();
    }
  }

  res.set("WWW-Authenticate", 'Basic realm="Panel Admin"');
  res.status(401).send("Acceso denegado");
});

// =============================
// 🌍 CORS GLOBAL
// =============================
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Range");
  next();
});

// =============================
// 📡 CONFIGURACIÓN DE CANALES
// =============================
const CHANNELS_PATH = path.join(process.cwd(), "channels.json");
let channels = JSON.parse(fs.readFileSync(CHANNELS_PATH, "utf8"));

const channelStatus = {};
const PLAYLIST_CACHE = {};
const CHECK_INTERVAL = 10000; // 10 segundos

for (const ch in channels) {
  channelStatus[ch] = { live: false, lastCheck: 0 };
  PLAYLIST_CACHE[ch] = "#EXTM3U\n";
}

// =============================
// 🧠 FUNCIÓN DE TESTEO DE LIVE
// =============================
async function checkLive(channel) {
  const url = channels[channel].live;
  try {
    const response = await fetch(url, {
      headers: {
        Range: "bytes=0-200",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        "Referer": "https://streamingtv.masplay.x10.mx"
      },
      timeout: 5000
    });
    const text = await response.text();
    const ok = response.ok && text.includes(".ts");
    channelStatus[channel].live = ok;
    return ok;
  } catch {
    channelStatus[channel].live = false;
    return false;
  }
}

// =============================
// 🔁 VERIFICACIÓN PERIÓDICA
// =============================
setInterval(() => {
  for (const ch in channels) {
    checkLive(ch);
  }
}, CHECK_INTERVAL);

// =============================
// 🎬 ENDPOINT DE STREAMING
// =============================
app.get("/stream/:channel", async (req, res) => {
  const channel = req.params.channel;

  if (!channels[channel]) {
    return res.status(404).send("Canal no encontrado");
  }

  const isLive = channelStatus[channel]?.live;
  const url = isLive ? channels[channel].live : channels[channel].cloud;

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        "Referer": "https://streamingtv.masplay.x10.mx"
      }
    });

    let text = await response.text();

    // Reescribir rutas absolutas para que los .ts pasen por el proxy
    text = text.replace(/(https?:\/\/[^\s"']+)/g, match =>
      `/proxy?url=${encodeURIComponent(match)}`
    );

    // Si hay rutas relativas, prepéndelas también al proxy
    text = text.replace(/^(?!#)(.*\.ts)$/gm, match =>
      `/proxy?url=${encodeURIComponent(new URL(match, url).href)}`
    );

    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.send(text);
  } catch (error) {
    res.status(500).send("Error al obtener el stream: " + error.message);
  }
});

// =============================
// 🚀 PROXY DIRECTO PARA TS Y M3U8
// =============================
app.get("/proxy", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send("Falta parámetro ?url=");

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        "Referer": "https://streamingtv.masplay.x10.mx"
      }
    });

    // Copiar encabezados relevantes
    res.set("Content-Type", response.headers.get("content-type") || "application/octet-stream");

    // Transmitir el contenido directamente
    response.body.pipe(res);
  } catch (err) {
    res.status(500).send("Error al obtener proxy: " + err.message);
  }
});

// =============================
// 📄 ADMIN: GUARDAR CAMBIOS EN CANALES
// =============================
app.post("/admin/save", (req, res) => {
  channels = req.body;
  fs.writeFileSync(CHANNELS_PATH, JSON.stringify(channels, null, 2), "utf8");
  res.json({ status: "ok" });
});

// =============================
// 🧾 LISTAR CANALES
// =============================
app.get("/channels", (req, res) => {
  res.json(channels);
});

// =============================
// 🏁 INICIO DEL SERVIDOR
// =============================
app.listen(PORT, () => {
  console.log(`Servidor proxy TV corriendo en puerto ${PORT}`);
});
