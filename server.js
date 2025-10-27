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
// 🔐 Panel Admin (opcional)
// =============================
const ADMIN_USER = process.env.ADMIN_USER || "";
const ADMIN_PASS = process.env.ADMIN_PASS || "";

app.use("/admin", (req, res, next) => {
  const authHeader = req.headers.authorization || "";
  const [type, credentials] = authHeader.split(" ");
  if (type === "Basic" && credentials) {
    const [user, pass] = Buffer.from(credentials, "base64").toString().split(":");
    if (user === ADMIN_USER && pass === ADMIN_PASS) return next();
  }
  res.set("WWW-Authenticate", 'Basic realm="Panel Admin"');
  res.status(401).send("Acceso denegado");
});

// =============================
// 📺 Configuración de canales
// =============================
const CHANNELS_PATH = path.join(process.cwd(), "channels.json");
let channels = JSON.parse(fs.readFileSync(CHANNELS_PATH, "utf8"));

// Estado interno
const channelStatus = {};
const usuariosConectados = {};
const PLAYLIST_CACHE = {};
for (const ch in channels) {
  channelStatus[ch] = { live: false, lastCheck: 0 };
  usuariosConectados[ch] = 0;
  PLAYLIST_CACHE[ch] = "#EXTM3U\n";
}

// =============================
// 🧠 Verificar si el canal está en vivo
// =============================
async function checkLive(channel) {
  const url = channels[channel].live;
  try {
    const res = await fetch(url, { headers: { Range: "bytes=0-300" }, timeout: 5000 });
    const text = await res.text();
    const ok = res.ok && text.includes(".ts");
    channelStatus[channel].live = ok;
    return ok;
  } catch {
    channelStatus[channel].live = false;
    return false;
  }
}

// =============================
// 🌍 CORS global
// =============================
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,HEAD,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Range");
  next();
});

// =============================
// 🧰 API de canales (panel admin)
// =============================
app.get("/api/channels", (req, res) => res.json(channels));

app.post("/api/channels", (req, res) => {
  channels = req.body;
  fs.writeFileSync(CHANNELS_PATH, JSON.stringify(channels, null, 2));
  res.json({ message: "Canales actualizados correctamente" });
});

// =============================
// 🎛️ Proxy para playlist (m3u8)
// =============================
app.get("/proxy/:channel/playlist.m3u8", async (req, res) => {
  const { channel } = req.params;
  const config = channels[channel];
  if (!config) return res.status(404).send("Canal no encontrado");

  let isLive = await checkLive(channel);
  const playlistUrl = isLive ? config.live : config.cloud;

  try {
    const response = await fetch(playlistUrl);
    let text = await response.text();

    // Corrige las URLs de los segmentos
    text = text.replace(/^(?!#)(.*\.ts.*)$/gm, (line) => {
      if (line.startsWith("http")) return line;
      return `/proxy/${channel}/${line}`;
    });

    // Guardar en caché (para cortes)
    PLAYLIST_CACHE[channel] = text;

    // Contar usuarios conectados
    usuariosConectados[channel]++;
    res.on("close", () => {
      usuariosConectados[channel]--;
    });

    res.header("Content-Type", "application/vnd.apple.mpegurl");
    res.send(text);
  } catch (err) {
    console.warn(`⚠️ Error en ${channel}: ${err.message}, usando cache`);
    res.header("Content-Type", "application/vnd.apple.mpegurl");
    res.send(PLAYLIST_CACHE[channel]);
  }
});

// =============================
// 🎞️ Proxy para segmentos .ts
// =============================
app.use("/proxy/:channel/", async (req, res, next) => {
  const { channel } = req.params;
  const config = channels[channel];
  if (!config) return res.status(404).send("Canal no encontrado");

  let isLive = channelStatus[channel].live;
  if (!isLive) isLive = await checkLive(channel);

  const baseUrl = isLive ? config.live : config.cloud;
  const urlObj = new URL(baseUrl);
  urlObj.pathname = urlObj.pathname.substring(0, urlObj.pathname.lastIndexOf("/") + 1);
  const baseDir = urlObj.toString();

  usuariosConectados[channel]++;
  res.on("close", () => {
    usuariosConectados[channel]--;
  });

  return createProxyMiddleware({
    target: baseDir,
    changeOrigin: true,
    pathRewrite: { [`^/proxy/${channel}/`]: "" },
    onProxyRes: (proxyRes, req, res) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Accept-Ranges", "bytes");
    }
  })(req, res, next);
});

// =============================
// 📊 Estado de cada canal
// =============================
app.get("/status/:channel", (req, res) => {
  const { channel } = req.params;
  if (!channels[channel]) return res.status(404).json({ error: "Canal no encontrado" });
  res.json({
    live: channelStatus[channel].live,
    usuariosConectados: usuariosConectados[channel] || 0
  });
});

// =============================
// 🚀 Iniciar servidor
// =============================
app.listen(PORT, () => {
  console.log(`✅ Proxy funcionando en http://localhost:${PORT}`);
});
