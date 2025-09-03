import events from "events";
events.EventEmitter.defaultMaxListeners = 1000; // o el número que quieras
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

const channelStatus = {};
const PLAYLIST_CACHE = {};
const CHECK_INTERVAL = 60;

// Inicializar estado
for (const ch in channels) {
  channelStatus[ch] = { live: false };
  PLAYLIST_CACHE[ch] = "#EXTM3U\n";
}

// Checker en background
async function checkLive(channel, url) {
  try {
    const resp = await fetch(url, { method: "HEAD", timeout: 3000 });
    channelStatus[channel].live = resp.ok;
  } catch {
    channelStatus[channel].live = false;
  }
}

for (const ch in channels) {
  setInterval(() => checkLive(ch, channels[ch].live), CHECK_INTERVAL);
}

// Middleware CORS global
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,HEAD,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Range");
  next();
});

// Playlist proxy
app.get("/proxy/:channel/playlist.m3u8", async (req, res) => {
  const { channel } = req.params;
  const config = channels[channel];
  if (!config) return res.status(404).send("Canal no encontrado");

  const playlistUrl = channelStatus[channel].live ? config.live : config.cloud;

  try {
    const response = await fetch(playlistUrl);
    let text = await response.text();

    text = text.replace(/(.*?\.ts)/g, `/proxy/${channel}/$1`);
    PLAYLIST_CACHE[channel] = text;

    res.header("Content-Type", "application/vnd.apple.mpegurl");
    res.send(text);
  } catch {
    res.header("Content-Type", "application/vnd.apple.mpegurl");
    res.send(PLAYLIST_CACHE[channel]);
  }
});

// Proxies de segmentos (uno por canal, creados solo una vez)
for (const channel in channels) {
  app.use(`/proxy/${channel}/`, (req, res, next) => {
    const config = channels[channel];
    const baseUrl = (channelStatus[channel].live ? config.live : config.cloud).replace(/[^/]+$/, "");

    createProxyMiddleware({
      target: baseUrl,
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
}

app.listen(PORT, () => console.log(`✅ Proxy estable en http://localhost:${PORT}`));
