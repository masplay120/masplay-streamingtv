import express from "express";
import fetch from "node-fetch";
import { createProxyMiddleware } from "http-proxy-middleware";

const app = express();

// 🔹 Configura tus canales aquí
const channels = {
  mixtv: {
    live: "https://streamlive8.hearthis.at/hls/10778826_orig/index.m3u8",
    cloud: "https://live20.bozztv.com/giatvplayout7/giatv-208566/tracks-v1a1/mono.ts.m3u8"
  },
  otrocanal: {
    live: "https://example.com/otrocanal/live.m3u8",
    cloud: "https://example.com/otrocanal/vod.m3u8"
  },
  tercercanal: {
    live: "https://example.com/tercercanal/live.m3u8",
    cloud: "https://example.com/tercercanal/vod.m3u8"
  }
};

// 🔹 CORS
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,HEAD,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Range");
  next();
});

// 🔹 Verifica si el canal en vivo está disponible
async function isLive(url) {
  try {
    const res = await fetch(url, { method: "HEAD", timeout: 3000 });
    return res.ok;
  } catch {
    return false;
  }
}

// 🔹 Endpoint para servir el playlist.m3u8 con rutas .ts reescritas
app.get(""/prox/:channel/playlist.m3u8", async (req, res) => {
  const { channel } = req.params;
  const config = channels[channel];
  if (!config) return res.status(404).send("Canal no encontrado");

  const liveAvailable = await isLive(config.live);
  const playlistUrl = liveAvailable ? config.live : config.cloud;

  const r = await fetch(playlistUrl);
  let text = await r.text();

  // Reescribir rutas de segmentos .ts para que pasen por el proxy
  text = text.replace(/(.*?\.ts)/g, `/proxy/${channel}/$1`);

  res.header("Content-Type", "application/vnd.apple.mpegurl");
  res.send(text);
});

// 🔹 Proxy para los segmentos .ts
app.use("/proxy/:channel/:segment", async (req, res, next) => {
  const { channel } = req.params;
  const config = channels[channel];
  if (!config) return res.status(404).send("Canal no encontrado");

  const liveAvailable = await isLive(config.live);
  const baseTarget = liveAvailable ? config.live : config.cloud;

  const urlObj = new URL(baseTarget);
  const baseUrl = `${urlObj.protocol}//${urlObj.host}${urlObj.pathname.substring(0, urlObj.pathname.lastIndexOf('/') + 1)}`;

  createProxyMiddleware({
    target: baseUrl,
    changeOrigin: true,
    selfHandleResponse: false,
    pathRewrite: (path) => path.replace(`/proxy/${channel}/`, ""),
    onProxyRes: (proxyRes, req, res) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Range");
    }
  })(req, res, next);
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`✅ Proxy HLS corriendo en http://localhost:${PORT}`);
});
