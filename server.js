import fs from "fs";
import path from "path";
import express from "express";
import fetch from "node-fetch";
import { createProxyMiddleware } from "http-proxy-middleware";
import pRetry from "p-retry";
import rateLimit from "express-rate-limit";
import { Agent } from "http";
import compression from "compression";

// Configuration
const app = express();
const PORT = process.env.PORT || 8080;
const CHANNELS_PATH = path.join(process.cwd(), "channels.json");
const CHECK_INTERVAL = 10_000; // 10 seconds
const CACHE_TTL = 30_000; // 30 seconds for playlist cache
const FETCH_TIMEOUT = 5_000; // 5 seconds timeout for fetch
const MAX_RETRIES = 3; // Retry failed requests up to 3 times

// Load channels
let channels = JSON.parse(fs.readFileSync(CHANNELS_PATH, "utf8"));

// State management
const channelStatus = {};
const PLAYLIST_CACHE = {};

// Initialize channel status
for (const ch in channels) {
  channelStatus[ch] = { live: false, lastCheck: 0, source: "cloud" };
  PLAYLIST_CACHE[ch] = { content: "#EXTM3U\n", lastUpdated: 0 };
}

// HTTP agent for connection pooling
const httpAgent = new Agent({ keepAlive: true, maxSockets: 100 });

// =============================
// 🔐 SECURITY & MIDDLEWARE
// =============================
app.use(compression()); // Enable response compression
app.use(express.json());

// Rate limiting for admin panel
const adminRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // 100 requests per window
});
app.use("/admin", adminRateLimiter);

// Admin authentication
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

// CORS
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,HEAD,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Range");
  next();
});

// =============================
// 🧠 LIVE STATUS CHECKER
// =============================
async function checkLive(channel) {
  const url = channels[channel].live;
  try {
    const response = await pRetry(
      () =>
        fetch(url, {
          headers: { "User-Agent": "HLS-Proxy/1.0" },
          timeout: FETCH_TIMEOUT,
          agent: httpAgent,
        }),
      { retries: MAX_RETRIES }
    );
    const text = await response.text();
    const isValid = response.ok && response.headers.get("content-type")?.includes("application/vnd.apple.mpegurl") && text.includes("#EXTM3U");
    channelStatus[channel].live = isValid;
    channelStatus[channel].lastCheck = Date.now();
    channelStatus[channel].source = isValid ? "live" : "cloud";
    return isValid;
  } catch (err) {
    console.warn(`⚠️ Failed to check live status for ${channel}: ${err.message}`);
    channelStatus[channel].live = false;
    channelStatus[channel].source = "cloud";
    return false;
  }
}

// Background worker to check live status
setInterval(async () => {
  for (const channel in channels) {
    if (Date.now() - channelStatus[channel].lastCheck > CHECK_INTERVAL) {
      await checkLive(channel);
    }
  }
}, CHECK_INTERVAL);

// =============================
// 🧰 ADMIN PANEL
// =============================
app.use("/admin", express.static("admin"));

app.get("/api/channels", (req, res) => res.json(channels));

app.post("/api/channels", (req, res) => {
  channels = req.body;
  fs.writeFileSync(CHANNELS_PATH, JSON.stringify(channels, null, 2));
  // Update channel status for new channels
  for (const ch in channels) {
    if (!channelStatus[ch]) {
      channelStatus[ch] = { live: false, lastCheck: 0, source: "cloud" };
      PLAYLIST_CACHE[ch] = { content: "#EXTM3U\n", lastUpdated: 0 };
    }
  }
  res.json({ message: "Canales actualizados correctamente" });
});

// =============================
// 🎛️ PLAYLIST PROXY
// =============================
app.get("/proxy/:channel/playlist.m3u8", async (req, res) => {
  const { channel } = req.params;
  const config = channels[channel];
  if (!config) return res.status(404).send("Canal no encontrado");

  // Use cached source decision if recent
  if (Date.now() - channelStatus[channel].lastCheck > CHECK_INTERVAL) {
    await checkLive(channel);
  }

  const playlistUrl = channelStatus[channel].live ? config.live : config.cloud;

  // Check cache validity
  if (PLAYLIST_CACHE[channel].lastUpdated > Date.now() - CACHE_TTL) {
    res.header("Content-Type", "application/vnd.apple.mpegurl");
    return res.send(PLAYLIST_CACHE[channel].content);
  }

  try {
    const response = await pRetry(
      () =>
        fetch(playlistUrl, {
          headers: { "User-Agent": "HLS-Proxy/1.0" },
          timeout: FETCH_TIMEOUT,
          agent: httpAgent,
        }),
      { retries: MAX_RETRIES }
    );
    let text = await response.text();

    // Rewrite URLs for all resources (.ts, .key, etc.)
    const baseUrl = new URL(playlistUrl);
    baseUrl.pathname = baseUrl.pathname.substring(0, baseUrl.pathname.lastIndexOf("/") + 1);
    const baseDir = baseUrl.toString();

    text = text.replace(/^(?!#)(.*\.(ts|key|m3u8).*)$/gm, (match, url) => {
      if (url.startsWith("http")) {
        // Proxy absolute URLs
        return `/proxy/${channel}/${encodeURIComponent(url)}`;
      }
      return `/proxy/${channel}/${url}`;
    });

    // Cache the playlist
    PLAYLIST_CACHE[channel] = { content: text, lastUpdated: Date.now() };

    res.header("Content-Type", "application/vnd.apple.mpegurl");
    res.send(text);
  } catch (err) {
    console.warn(`⚠️ Error fetching playlist for ${channel}: ${err.message}`);
    if (PLAYLIST_CACHE[channel].content.includes("#EXTM3U")) {
      res.header("Content-Type", "application/vnd.apple.mpegurl");
      return res.send(PLAYLIST_CACHE[channel].content);
    }
    res.status(500).send("Error al obtener la lista de reproducción");
  }
});

// =============================
// 🎞️ SEGMENT & RESOURCE PROXY
// =============================
app.use("/proxy/:channel/*", async (req, res, next) => {
  const { channel } = req.params;
  const config = channels[channel];
  if (!config) return res.status(404).send("Canal no encontrado");

  // Use cached source decision
  const baseUrl = channelStatus[channel].live ? config.live : config.cloud;
  const urlObj = new URL(baseUrl);
  urlObj.pathname = urlObj.pathname.substring(0, urlObj.pathname.lastIndexOf("/") + 1);
  const baseDir = urlObj.toString();
  const resourcePath = req.originalUrl.split(`/proxy/${channel}/`)[1];

  let targetUrl;
  if (resourcePath.startsWith("http%3A")) {
    // Handle encoded absolute URLs
    targetUrl = decodeURIComponent(resourcePath);
  } else {
    targetUrl = `${baseDir}${resourcePath}`;
  }

  return createProxyMiddleware({
    target: targetUrl,
    changeOrigin: true,
    pathRewrite: { [`^/proxy/${channel}/.*`]: "" },
    onProxyRes: (proxyRes, req, res) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Range");
      res.setHeader("Accept-Ranges", "bytes");
    },
    onError: (err, req, res) => {
      console.warn(`⚠️ Proxy error for ${channel}: ${err.message}`);
      res.status(500).send("Error al obtener el recurso");
    },
  })(req, res, next);
});

// =============================
// 📊 CHANNEL STATUS
// =============================
app.get("/status/:channel", (req, res) => {
  const { channel } = req.params;
  if (!channels[channel]) return res.status(404).json({ error: "Canal no encontrado" });
  res.json({ live: channelStatus[channel].live, source: channelStatus[channel].source });
});

// =============================
// 🚀 SERVER START
// =============================
app.listen(PORT, () => {
  console.log(`✅ Proxy TV con conmutación en vivo activo en http://localhost:${PORT}`);
});
