import fs from "fs";
import path from "path";
import express from "express";
import fetch from "node-fetch";
import { createProxyMiddleware } from "http-proxy-middleware";
import events from "events";
events.EventEmitter.defaultMaxListeners = 1000000;

const app = express();
const PORT = process.env.PORT || 8080;
app.use(express.json());

// =============================
// 🔐 SEGURIDAD ADMIN PANEL
// =============================


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
    const response = await fetch(url, { headers: { Range: "bytes=0-200" }, timeout: 5000 });
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
// 🌍 CORS
// =============================
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,HEAD,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Range");
  next();
});

// =============================
// 🧰 PANEL ADMIN (protegido)
// =============================
app.use("/admin", express.static("admin"));

app.get("/api/channels", (req, res) => res.json(channels));

app.post("/api/channels", (req, res) => {
  channels = req.body;
  fs.writeFileSync(CHANNELS_PATH, JSON.stringify(channels, null, 2));
  res.json({ message: "Canales actualizados correctamente" });
});

// =============================
// 🎛️ PROXY DE PLAYLIST
// =============================
app.get("/proxy/:channel/playlist.m3u8", async (req, res) => {
  const { channel } = req.params;
  const config = channels[channel];
  if (!config) return res.status(404).send("Canal no encontrado");

  // Verificar en tiempo real si el LIVE funciona
  let isLive = await checkLive(channel);
  const playlistUrl = isLive ? config.live : config.cloud;

  try {
    const response = await fetch(playlistUrl);
    let text = await response.text();

    // Reescribir rutas .ts
    text = text.replace(/^(?!#)(.*\.ts.*)$/gm, (line) => {
      if (line.startsWith("http")) return line;
      return `/proxy/${channel}/${line}`;
    });

    PLAYLIST_CACHE[channel] = text;

    res.header("Content-Type", "application/vnd.apple.mpegurl");
    res.send(text);
  } catch (err) {
    console.warn(`⚠️ Error en ${channel}: ${err.message}, usando cache`);
    res.header("Content-Type", "application/vnd.apple.mpegurl");
    res.send(PLAYLIST_CACHE[channel]);
  }
});

// =============================
// 🎞️ PROXY DE SEGMENTOS (TS)
// =============================
app.use("/proxy/:channel/", async (req, res, next) => {
  const { channel } = req.params;
  const config = channels[channel];
  if (!config) return res.status(404).send("Canal no encontrado");

  // Cada solicitud de segmento también verifica el estado actual
  let isLive = channelStatus[channel].live;
  if (!isLive) {
    isLive = await checkLive(channel);
  }

  const baseUrl = isLive ? config.live : config.cloud;
  const urlObj = new URL(baseUrl);
  urlObj.pathname = urlObj.pathname.substring(0, urlObj.pathname.lastIndexOf("/") + 1);
  const baseDir = urlObj.toString();

  return createProxyMiddleware({
    target: baseDir,
    changeOrigin: true,
    pathRewrite: { [`^/proxy/${channel}/`]: "" },
    onProxyRes: (proxyRes, req, res) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Range");
      res.setHeader("Accept-Ranges", "bytes");
    }
  })(req, res, next);
});

// =============================
// 📊 ESTADO DE CANALES
// =============================
app.get("/status/:channel", (req, res) => {
  const { channel } = req.params;
  if (!channels[channel]) return res.status(404).json({ error: "Canal no encontrado" });
  res.json({ live: channelStatus[channel].live });
});

// =============================
// 🚀 INICIO DEL SERVIDOR
// =============================
app.listen(PORT, () => {
  console.log(`✅ Proxy TV con conmutación en vivo activo en http://localhost:${PORT}`);
});
