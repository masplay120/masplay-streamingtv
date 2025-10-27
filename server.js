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
const ADMIN_USER = process.env.ADMIN_USER || "";
const ADMIN_PASS = process.env.ADMIN_PASS || "";

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
const CACHE_TTL = 15000; // 15 segundos
const CHECK_INTERVAL = 10000;

for (const ch in channels) {
  channelStatus[ch] = { live: false, lastCheck: 0 };
  PLAYLIST_CACHE[ch] = { data: "#EXTM3U\n", timestamp: 0 };
}

// =============================
// 🧠 FUNCIÓN DE TESTEO DE LIVE CON FALLBACK
// =============================
async function checkLive(channel) {
  const url = channels[channel].live;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);

    const response = await fetch(url, {
      headers: { Range: "bytes=0-200" },
      signal: controller.signal
    });
    clearTimeout(timeout);

    const text = await response.text();
    const ok = response.ok && text.includes(".ts");

    channelStatus[channel].live = ok;
    channelStatus[channel].lastCheck = Date.now();

    if (!ok) {
      PLAYLIST_CACHE[channel] = { data: "#EXTM3U\n", timestamp: 0 };
    }

    return ok;
  } catch {
    channelStatus[channel].live = false;
    channelStatus[channel].lastCheck = Date.now();
    PLAYLIST_CACHE[channel] = { data: "#EXTM3U\n", timestamp: 0 };
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
// 👥 CONEXIONES ACTIVAS
// =============================
const conexionesActivas = {}; // { canal: { "ip|ua": { dispositivo, ultimaVez } } }
const TTL = 30000; // 30 segundos

function detectarDispositivo(userAgent) {
  userAgent = userAgent.toLowerCase();
  if (/smart|hbbtv|tv|netcast|tizen|roku|firetv|bravia/.test(userAgent)) return "SmartTV";
  if (/mobile|iphone|android|tablet|ipad/.test(userAgent)) return "Móvil";
  return "PC";
}

function registrarConexion(canal, req) {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress;
  const ua = req.headers["user-agent"] || "Desconocido";
  const key = `${ip}|${ua}`;
  const dispositivo = detectarDispositivo(ua);

  if (!conexionesActivas[canal]) conexionesActivas[canal] = {};
  conexionesActivas[canal][key] = { dispositivo, ultimaVez: Date.now() };
}

function limpiarConexiones() {
  const ahora = Date.now();
  for (const canal in conexionesActivas) {
    for (const key in conexionesActivas[canal]) {
      if (ahora - conexionesActivas[canal][key].ultimaVez > TTL) {
        delete conexionesActivas[canal][key];
      }
    }
  }
}
setInterval(limpiarConexiones, 10000);

function obtenerEstadoCanal(canal) {
  const usuarios = conexionesActivas[canal] || {};
  const total = Object.keys(usuarios).length;
  const porDispositivo = { PC: 0, Móvil: 0, SmartTV: 0 };
  for (const key in usuarios) {
    const tipo = usuarios[key].dispositivo;
    porDispositivo[tipo] = (porDispositivo[tipo] || 0) + 1;
  }
  return { total, porDispositivo };
}

// =============================
// 🧰 PANEL ADMIN
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

  registrarConexion(channel, req);

  const now = Date.now();
  let isLive =
    channelStatus[channel].live ||
    (now - channelStatus[channel].lastCheck > CHECK_INTERVAL && (await checkLive(channel)));

  const playlistUrl = isLive ? config.live : config.cloud;

  console.log(`🔄 Canal ${channel}: live=${channelStatus[channel].live} → ${isLive ? "LIVE" : "CLOUD"}`);

  try {
    const response = await fetch(playlistUrl);
    let text = await response.text();

    text = text.replace(/^(?!#)(.*\.ts.*)$/gm, (line) => {
      if (line.startsWith("http")) return line;
      return `/proxy/${channel}/${line}`;
    });

    PLAYLIST_CACHE[channel] = { data: text, timestamp: Date.now() };
    res.header("Content-Type", "application/vnd.apple.mpegurl");
    res.send(text);
  } catch (err) {
    const cache = PLAYLIST_CACHE[channel];
    if (Date.now() - cache.timestamp < CACHE_TTL) {
      console.warn(`⚠️ Error en ${channel}: ${err.message}, usando cache`);
      res.header("Content-Type", "application/vnd.apple.mpegurl");
      res.send(cache.data);
    } else {
      res.status(500).send("Error al cargar playlist");
    }
  }
});

// =============================
// 🎞️ PROXY DE SEGMENTOS TS
// =============================
app.use("/proxy/:channel/", async (req, res, next) => {
  const { channel } = req.params;
  const config = channels[channel];
  if (!config) return res.status(404).send("Canal no encontrado");

  registrarConexion(channel, req);

  let isLive = channelStatus[channel].live;
  if (!isLive) isLive = await checkLive(channel);

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
// 📊 ESTADO DEL CANAL
// =============================
app.get("/status/:channel", (req, res) => {
  const { channel } = req.params;
  if (!channels[channel]) return res.status(404).json({ error: "Canal no encontrado" });

  const estado = obtenerEstadoCanal(channel);
  res.json({
    live: channelStatus[channel].live,
    usuariosConectados: estado.total,
    dispositivos: estado.porDispositivo
  });
});

// =============================
// 🚀 INICIO DEL SERVIDOR
// =============================
app.listen(PORT, () => {
  console.log(`✅ Proxy TV activo en http://localhost:${PORT}`);
});
