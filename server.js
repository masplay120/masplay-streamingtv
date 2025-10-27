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
const SEGMENT_CACHE = {}; // 👈 Nuevo: cache de segmentos
const usuariosConectados = {};

for (const ch in channels) {
  channelStatus[ch] = { live: false, lastCheck: 0 };
  PLAYLIST_CACHE[ch] = "#EXTM3U\n";
  usuariosConectados[ch] = 0;
  SEGMENT_CACHE[ch] = {}; // guardar pequeños ts
}

// =============================
// 🧠 FUNCIÓN DE TESTEO DE LIVE
// =============================
async function checkLive(channel) {
  const url = channels[channel].live;
  try {
    const response = await fetch(url, { headers: { Range: "bytes=0-200" }, timeout: 4000 });
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
// 🧾 LOG DE CONEXIONES
// =============================
function registrarConexion(req, channel) {
  const userAgent = req.headers["user-agent"] || "Desconocido";
  const referer = req.headers["referer"] || "Directo";

  let tipo = "PC";
  if (/mobile/i.test(userAgent)) tipo = "Móvil";
  if (/smart|hbbtv|netcast|tizen|webos/i.test(userAgent)) tipo = "TV";

  const info = {
    canal: channel,
    tipo,
    userAgent,
    referer,
    ip: req.headers["x-forwarded-for"] || req.connection.remoteAddress,
    fecha: new Date().toISOString(),
  };

  const logPath = path.join(process.cwd(), "connections.log");
  fs.appendFileSync(logPath, JSON.stringify(info) + "\n");
}

// =============================
// 🎛️ PROXY DE PLAYLIST
// =============================
app.get("/proxy/:channel/playlist.m3u8", async (req, res) => {
  const { channel } = req.params;
  const config = channels[channel];
  if (!config) return res.status(404).send("Canal no encontrado");

  registrarConexion(req, channel);
  usuariosConectados[channel]++;

  res.on("finish", () => {
    usuariosConectados[channel] = Math.max(0, usuariosConectados[channel] - 1);
  });

  // Detectar si está en vivo
  let isLive = await checkLive(channel);
  const playlistUrl = isLive ? config.live : config.cloud;

  try {
    const response = await fetch(playlistUrl);
    let text = await response.text();

    // Reescribir rutas .ts para proxy
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
// 🎞️ PROXY DE SEGMENTOS (TS) CON CACHE
// =============================
app.get("/proxy/:channel/:segment", async (req, res, next) => {
  const { channel, segment } = req.params;
  const config = channels[channel];
  if (!config) return res.status(404).send("Canal no encontrado");

  registrarConexion(req, channel);
  usuariosConectados[channel]++;

  res.on("finish", () => {
    usuariosConectados[channel] = Math.max(0, usuariosConectados[channel] - 1);
  });

  let isLive = channelStatus[channel].live || (await checkLive(channel));
  const baseUrl = isLive ? config.live : config.cloud;
  const urlObj = new URL(baseUrl);
  urlObj.pathname = urlObj.pathname.substring(0, urlObj.pathname.lastIndexOf("/") + 1);
  const segmentUrl = `${urlObj}${segment}`;

  // Si existe en cache, servirlo rápido
  if (SEGMENT_CACHE[channel][segment]) {
    res.setHeader("Content-Type", "video/MP2T");
    return res.end(SEGMENT_CACHE[channel][segment]);
  }

  try {
    const response = await fetch(segmentUrl);
    if (!response.ok) throw new Error("No se pudo obtener segmento");
    const buffer = await response.arrayBuffer();

    // Guardar una copia en cache (máximo 5 segmentos)
    const keys = Object.keys(SEGMENT_CACHE[channel]);
    if (keys.length > 5) delete SEGMENT_CACHE[channel][keys[0]];
    SEGMENT_CACHE[channel][segment] = Buffer.from(buffer);

    res.setHeader("Content-Type", "video/MP2T");
    res.end(Buffer.from(buffer));
  } catch (err) {
    console.warn(`⚠️ Error segmento ${segment}: ${err.message}`);
    if (SEGMENT_CACHE[channel][segment]) {
      res.setHeader("Content-Type", "video/MP2T");
      res.end(SEGMENT_CACHE[channel][segment]);
    } else {
      res.status(404).end();
    }
  }
});

// =============================
// 📊 ESTADO DE CANALES
// =============================
app.get("/status/:channel", (req, res) => {
  const { channel } = req.params;
  if (!channels[channel]) return res.status(404).json({ error: "Canal no encontrado" });
  res.json({
    live: channelStatus[channel].live,
    usuariosConectados: usuariosConectados[channel] || 0,
  });
});

// =============================
// 🧾 LOG VIEWER (opcional)
// =============================
app.get("/logs", (req, res) => {
  try {
    const data = fs.readFileSync(path.join(process.cwd(), "connections.log"), "utf8");
    const logs = data.trim().split("\n").map((line) => JSON.parse(line));
    res.json(logs);
  } catch {
    res.json([]);
  }
});

// =============================
// 🚀 INICIO DEL SERVIDOR
// =============================
app.listen(PORT, () => {
  console.log(`✅ Proxy TV activo en http://localhost:${PORT}`);
});
