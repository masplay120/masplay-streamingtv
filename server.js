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
const PLAYLIST_CACHE = {}; // para guardar últimas playlists

// --- Checker en segundo plano ---
async function checkLive(channel, url) {
  try {
    const resp = await fetch(url, { method: "HEAD", timeout: 3000 });
    channelStatus[channel].live = resp.ok;
  } catch {
    channelStatus[channel].live = false;
  }
}

for (const ch in channels) {
  channelStatus[ch] = { live: false };
  // cada 5s verificamos en background
  setInterval(() => checkLive(ch, channels[ch].live), 5000);
}

// --- Middleware CORS ---
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,HEAD,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Range");
  next();
});

// --- Playlist con fallback inmediato ---
app.get("/proxy/:channel/playlist.m3u8", async (req, res) => {
  const { channel } = req.params;
  const config = channels[channel];
  if (!config) return res.status(404).send("Canal no encontrado");

  const useLive = channelStatus[channel]?.live;
  const playlistUrl = useLive ? config.live : config.cloud;

  try {
    const response = await fetch(playlistUrl);
    let text = await response.text();

    // Reescribir segmentos al proxy
    text = text.replace(/(.*?\.ts)/g, `/proxy/${channel}/$1`);

    PLAYLIST_CACHE[channel] = text; // cachear

    res.header("Content-Type", "application/vnd.apple.mpegurl");
    res.send(text);
  } catch (err) {
    // si falla, devolvemos la última playlist en caché
    if (PLAYLIST_CACHE[channel]) {
      res.header("Content-Type", "application/vnd.apple.mpegurl");
      return res.send(PLAYLIST_CACHE[channel]);
    }
    res.status(500).send("No se pudo obtener playlist");
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

app.listen(PORT, () => console.log(`✅ Proxy HLS estable en http://localhost:${PORT}`));
