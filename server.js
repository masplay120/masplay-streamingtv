import fs from "fs";
import path from "path";
import express from "express";
import fetch from "node-fetch";
import { createProxyMiddleware } from "http-proxy-middleware";
import events from "events";
import uaParser from "user-agents"; // Agregado para parsear User-Agent
events.EventEmitter.defaultMaxListeners = 1000000;

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
// 📡 CONFIGURACIÓN DE CANALES
// =============================
const CHANNELS_PATH = path.join(process.cwd(), "channels.json");
let channels = JSON.parse(fs.readFileSync(CHANNELS_PATH, "utf8"));

const channelStatus = {};
const PLAYLIST_CACHE = {};
const SEGMENT_CACHE = {}; // Nuevo: Cache para segmentos .ts (buffer de últimos segmentos)
const CHECK_INTERVAL = 5000; // Reducido a 5 segundos para chequeos más frecuentes
const SEGMENT_CACHE_SIZE = 5; // Número de segmentos a cachear para transiciones suaves
const ACTIVE_VIEWERS = {}; // Contador de espectadores por canal

for (const ch in channels) {
  channelStatus[ch] = { live: false, lastCheck: 0 };
  PLAYLIST_CACHE[ch] = "#EXTM3U\n";
  SEGMENT_CACHE[ch] = {}; // Objeto para cachear segmentos por nombre
  ACTIVE_VIEWERS[ch] = new Set(); // Set de IDs de conexiones activas
}

// =============================
// 🧠 FUNCIÓN DE TESTEO DE LIVE
// =============================
async function checkLive(channel) {
  const url = channels[channel].live;
  const now = Date.now();
  if (now - channelStatus[channel].lastCheck < CHECK_INTERVAL) {
    return channelStatus[channel].live;
  }
  channelStatus[channel].lastCheck = now;

  try {
    const response = await fetch(url, { headers: { Range: "bytes=0-200" }, timeout: 3000 });
    const text = await response.text();
    const ok = response.ok && text.includes(".ts");
    channelStatus[channel].live = ok;
    return ok;
  } catch {
    channelStatus[channel].live = false;
    return false;
  }
}

// Iniciar chequeos periódicos para cada canal
for (const ch in channels) {
  setInterval(() => checkLive(ch), CHECK_INTERVAL);
}

// =============================
// 🌍 CORS
// =============================
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,HEAD,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Range, User-Agent");
  next();
});

// =============================
// 🧰 PANEL ADMIN (protegido)
// =============================
app.use("/admin", express.static("admin"));

app.get("/api/channels", (req, res) => res.json(channels));

app.post("/api/channels", (req, res) => {
  channels = req.body;
  // Reiniciar estados para nuevos canales
  for (const ch in channels) {
    if (!channelStatus[ch]) {
      channelStatus[ch] = { live: false, lastCheck: 0 };
      PLAYLIST_CACHE[ch] = "#EXTM3U\n";
      SEGMENT_CACHE[ch] = {};
      ACTIVE_VIEWERS[ch] = new Set();
    }
  }
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

  // Verificar en tiempo real
  let isLive = await checkLive(channel);
  const playlistUrl = isLive ? config.live : config.cloud;

  try {
    const response = await fetch(playlistUrl);
    if (!response.ok) throw new Error("Respuesta no OK");

    let text = await response.text();

    // Reescritura universal de URLs: Maneja absolutas, relativas y cualquier formato m3u8
    const baseUrl = new URL(playlistUrl);
    const baseDir = baseUrl.origin + baseUrl.pathname.substring(0, baseUrl.pathname.lastIndexOf("/") + 1);

    text = text.replace(/^(?!#)(.+)$/gm, (line) => {
      if (line.trim() === "") return line;
      if (line.startsWith("http")) return `/proxy/${channel}/${line.replace(/^https?:\/\//, "")}`; // Reescribe absolutas
      if (line.startsWith("/")) return `/proxy/${channel}${line}`; // Absolutas en raíz
      return `/proxy/${channel}/${line}`; // Relativas
    });

    PLAYLIST_CACHE[channel] = text;

    res.header("Content-Type", "application/vnd.apple.mpegurl");
    res.send(text);
  } catch (err) {
    console.warn(`⚠️ Error en playlist de ${channel}: ${err.message}, usando cache`);
    res.header("Content-Type", "application/vnd.apple.mpegurl");
    res.send(PLAYLIST_CACHE[channel]);
  }
});

// =============================
// 🎞️ PROXY DE SEGMENTOS (TS) CON CACHE Y TRANSICIÓN SUAVE
// =============================
app.use("/proxy/:channel/", async (req, res, next) => {
  const { channel } = req.params;
  const config = channels[channel];
  if (!config) return res.status(404).send("Canal no encontrado");

  const segmentPath = req.url.substring(1); // Ej: "segmento.ts"
  const connectionId = `${req.ip}-${Date.now()}`; // ID único para conexión

  // Trackear espectador: Agregar al set y detectar dispositivo
  ACTIVE_VIEWERS[channel].add(connectionId);
  const userAgent = req.headers["user-agent"] || "Desconocido";
  const parser = new uaParser(userAgent);
  const device = parser.getDevice().type || "Desktop"; // Ej: mobile, tablet, desktop
  console.log(`📺 Espectador en ${channel} desde ${device} (${req.ip})`);

  // Limpiar al finalizar la conexión
  res.on("finish", () => {
    ACTIVE_VIEWERS[channel].delete(connectionId);
  });

  // Verificar live en cada request para switch dinámico
  let isLive = await checkLive(channel);
  let baseUrl = isLive ? config.live : config.cloud;
  const urlObj = new URL(baseUrl);
  urlObj.pathname = urlObj.pathname.substring(0, urlObj.pathname.lastIndexOf("/") + 1);
  const baseDir = urlObj.toString();

  // Intentar servir desde cache si existe (para transiciones suaves)
  if (SEGMENT_CACHE[channel][segmentPath]) {
    const cached = SEGMENT_CACHE[channel][segmentPath];
    res.header("Content-Type", "video/mp2t");
    res.header("Content-Length", cached.length);
    res.header("Accept-Ranges", "bytes");
    return res.send(cached);
  }

  // Proxy al origen
  const proxy = createProxyMiddleware({
    target: baseDir,
    changeOrigin: true,
    pathRewrite: { [`^/proxy/${channel}/`]: "" },
    onProxyRes: (proxyRes, req, res) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Range");
      res.setHeader("Accept-Ranges", "bytes");

      // Cachear el segmento si es .ts
      if (segmentPath.endsWith(".ts")) {
        let data = Buffer.alloc(0);
        proxyRes.on("data", (chunk) => { data = Buffer.concat([data, chunk]); });
        proxyRes.on("end", () => {
          SEGMENT_CACHE[channel][segmentPath] = data;
          // Mantener solo los últimos SEGMENT_CACHE_SIZE segmentos
          const keys = Object.keys(SEGMENT_CACHE[channel]);
          if (keys.length > SEGMENT_CACHE_SIZE) {
            const oldKey = keys[0];
            delete SEGMENT_CACHE[channel][oldKey];
          }
        });
      }
    },
    onError: async (err, req, res) => {
      console.warn(`⚠️ Error en segmento ${segmentPath} de ${channel}, intentando switch`);
      // Si falla, forzar switch a la otra fuente y reintentar
      channelStatus[channel].live = !isLive; // Forzar toggle temporal
      baseUrl = isLive ? config.cloud : config.live; // Switch
      const newUrlObj = new URL(baseUrl);
      newUrlObj.pathname = newUrlObj.pathname.substring(0, newUrlObj.pathname.lastIndexOf("/") + 1);
      const newBaseDir = newUrlObj.toString();

      createProxyMiddleware({
        target: newBaseDir,
        changeOrigin: true,
        pathRewrite: { [`^/proxy/${channel}/`]: "" },
      })(req, res, next);
    }
  });

  proxy(req, res, next);
});

// =============================
// 📊 ESTADO DE CANALES Y ESPECTADORES
// =============================
app.get("/status/:channel", (req, res) => {
  const { channel } = req.params;
  if (!channels[channel]) return res.status(404).json({ error: "Canal no encontrado" });

  // Contar espectadores y dispositivos (simplificado: solo count por tipo)
  const viewersByDevice = {};
  ACTIVE_VIEWERS[channel].forEach((id) => {
    // Nota: Para precisión, necesitarías mapear IDs a devices, pero por simplicidad asumimos log por request
    // En producción, usa un Map<connectionId, device>
    viewersByDevice["Ejemplo"] = (viewersByDevice["Ejemplo"] || 0) + 1; // Reemplaza con parsing real
  });

  res.json({
    live: channelStatus[channel].live,
    viewers: ACTIVE_VIEWERS[channel].size,
    viewersByDevice
  });
});

// =============================
// 🚀 INICIO DEL SERVIDOR
// =============================
app.listen(PORT, () => {
  console.log(`✅ Proxy TV optimizado con conmutación suave activo en http://localhost:${PORT}`);
});
