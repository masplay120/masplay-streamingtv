import express from "express";
import fetch from "node-fetch";
import { createProxyMiddleware } from "http-proxy-middleware";

const app = express();
const PORT = process.env.PORT || 8080;

const channels = {
  mixtv: {
    live: "https://live20.bozztv.com/giatv/giatv-estacionmixtv/estacionmixtv/chunks.m3u8",
    cloud: "https://live20.bozztv.com/giatvplayout7/giatv-208566/tracks-v1a1/mono.ts.m3u8"
  }
};

// Estado de cada canal
const channelStatus = {};
const PLAYLIST_CACHE = {};
const CHECK_INTERVAL = 1000;

// Inicializar estado
for (const ch in channels) {
  channelStatus[ch] = { live: false, lastCheck: 0 };
  PLAYLIST_CACHE[ch] = "#EXTM3U\n"; // valor inicial
}

// --- Checker en background ---
async function checkLive(channel, url) {
  try {
    const resp = await fetch(url, { method: "HEAD", timeout: 3000 });
    channelStatus[channel].live = resp.ok;
  } catch {
    channelStatus[channel].live = false;
  }
  channelStatus[channel].lastCheck = Date.now();
}

// Lanzar checker cada X seg
for (const ch in channels) {
  setInterval(() => checkLive(ch, channels[ch].live), CHECK_INTERVAL);
}

// --- Middleware CORS ---
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,HEAD,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Range");
  next();
});

// --- Playlist proxyado con fallback ---
app.get("/proxy/:channel/playlist.m3u8", async (req, res) => {
  const { channel } = req.params;
  const config = channels[channel];
  if (!config) return res.status(404).send("Canal no encontrado");

  const useLive = channelStatus[channel]?.live;
  const playlistUrl = useLive ? config.live : config.cloud;

  try {
    const response = await fetch(playlistUrl, { timeout: 5000 });
    let text = await response.text();

    // Reescribir segmentos hacia proxy
    text = text.replace(/(.*?\.ts)/g, `/proxy/${channel}/$1`);

    // Guardar en cache
    PLAYLIST_CACHE[channel] = text;

    res.header("Content-Type", "application/vnd.apple.mpegurl");
    res.send(text);
  } catch (err) {
    // si falla, devolvemos cache estable
    res.header("Content-Type", "application/vnd.apple.mpegurl");
    res.send(PLAYLIST_CACHE[channel]);
  }
});

// --- Proxy dinámico para segmentos ---
app.use("/proxy/:channel/", (req, res, next) => {
  const { channel } = req.params;
  const config = channels[channel];
  if (!config) return res.status(404).send("Canal no encontrado");

  const useLive = channelStatus[channel]?.live;
  const baseUrl = (useLive ? config.live : config.cloud).replace(/[^/]+$/, "");

  createProxyMiddleware({
    target: baseUrl,
    changeOrigin: true,
    pathRewrite: (path) => path.replace(`/proxy/${channel}/`, ""),
    onProxyRes: (proxyRes, req, res) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Range");
      res.setHeader("Accept-Ranges", "bytes");
    }
  })(req, res, next);
});

app.listen(PORT, () => console.log(`✅ Proxy HLS robusto en http://localhost:${PORT}`));
