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

// Estado de fallos por canal
const channelStatus = {};
const FAIL_LIMIT = 3; // nº de intentos fallidos antes de cambiar a cloud

// Verificar si live responde
async function isLive(url) {
  try {
    const resp = await fetch(url, { method: "HEAD", timeout: 3000 });
    return resp.ok;
  } catch {
    return false;
  }
}

// CORS
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,HEAD,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Range");
  next();
});

// Playlist con fallback inteligente
app.get("/proxy/:channel/playlist.m3u8", async (req, res) => {
  const { channel } = req.params;
  const config = channels[channel];
  if (!config) return res.status(404).send("Canal no encontrado");

  if (!channelStatus[channel]) channelStatus[channel] = { fails: 0 };

  let useLive = true;
  const liveAvailable = await isLive(config.live);

  if (liveAvailable) {
    channelStatus[channel].fails = 0; // reset
  } else {
    channelStatus[channel].fails++;
    if (channelStatus[channel].fails >= FAIL_LIMIT) {
      useLive = false; // recién cambia después de varios fallos
    }
  }

  const playlistUrl = useLive ? config.live : config.cloud;
  const response = await fetch(playlistUrl);
  let text = await response.text();

  // Reescribir rutas
  text = text.replace(/(.*?\.ts)/g, `/proxy/${channel}/$1`);

  res.header("Content-Type", "application/vnd.apple.mpegurl");
  res.send(text);
});

// Proxy dinámico para segmentos
app.use("/proxy/:channel/", async (req, res, next) => {
  const { channel } = req.params;
  const config = channels[channel];
  if (!config) return res.status(404).send("Canal no encontrado");

  if (!channelStatus[channel]) channelStatus[channel] = { fails: 0 };

  const liveAvailable = await isLive(config.live);
  let useLive = true;

  if (liveAvailable) {
    channelStatus[channel].fails = 0;
  } else {
    channelStatus[channel].fails++;
    if (channelStatus[channel].fails >= FAIL_LIMIT) {
      useLive = false;
    }
  }

  const baseUrl = (useLive ? config.live : config.cloud).replace(/[^/]+$/, "");

  createProxyMiddleware({
    target: baseUrl,
    changeOrigin: true,
    pathRewrite: (path) => path.replace(`/proxy/${channel}/`, ""),
    selfHandleResponse: false,
    onProxyRes: (proxyRes, req, res) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Range");
      res.setHeader("Accept-Ranges", "bytes");
    }
  })(req, res, next);
});

app.listen(PORT, () => console.log(`✅ Proxy HLS con buffer corriendo en http://localhost:${PORT}`));
