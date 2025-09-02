import express from "express";
import fetch from "node-fetch";
import { createProxyMiddleware } from "http-proxy-middleware";

const app = express();
const PORT = process.env.PORT || 8080;

// Canales configurados
const channels = {
  mixtv: {
    live: "https://live20.bozztv.com/giatv/giatv-estacionmixtv/estacionmixtv/chunks.m3u8,
    cloud: "https://live20.bozztv.com/giatvplayout7/giatv-208566/tracks-v1a1/mono.ts.m3u8"
  }
};

// CORS
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,HEAD,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Range");
  next();
});

// Endpoint playlist.m3u8
app.get("/proxy/:channel/playlist.m3u8", async (req, res) => {
  const { channel } = req.params;
  const config = channels[channel];
  if (!config) return res.status(404).send("Canal no encontrado");

  let playlistUrl = config.cloud;

  try {
    // Comprobar si live responde
    const liveResp = await fetch(config.live, { method: "HEAD", timeout: 3000 });
    if (liveResp.ok) playlistUrl = config.live;
  } catch {}

  // Traer contenido de playlist
  const response = await fetch(playlistUrl);
  let text = await response.text();

  // Reescribir rutas de los segmentos
  text = text.replace(/(.*?\.ts)/g, `/proxy/${channel}/$1`);

  res.header("Content-Type", "application/vnd.apple.mpegurl");
  res.send(text);
});

// Endpoint dinámico para segmentos .ts
app.get("/proxy/:channel/:segment", async (req, res, next) => {
  const { channel, segment } = req.params;
  const config = channels[channel];
  if (!config) return res.status(404).send("Canal no encontrado");

  let baseUrl = config.cloud.substring(0, config.cloud.lastIndexOf("/") + 1);

  try {
    const liveResp = await fetch(config.live, { method: "HEAD", timeout: 3000 });
    if (liveResp.ok) baseUrl = config.live.substring(0, config.live.lastIndexOf("/") + 1);
  } catch {}

  // Proxy del segmento
  createProxyMiddleware({
    target: baseUrl,
    changeOrigin: true,
    pathRewrite: { [`^/proxy/${channel}/`]: "" },
    selfHandleResponse: false,
    onProxyRes: (proxyRes, req, res) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Range");
      res.setHeader("Accept-Ranges", "bytes");
    }
  })(req, res, next);
});

app.listen(PORT, () => console.log(`✅ Proxy HLS corriendo en http://localhost:${PORT}`));
