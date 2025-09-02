import express from "express";
import fetch from "node-fetch";
import { createProxyMiddleware } from "http-proxy-middleware";

const app = express();
const PORT = process.env.PORT || 8080;

const channels = {
  mixtv: {
    live: "https://live20.bozztv.com/giatv/giatv-estacionmixtv/estacionmixtv/playlist.m3u8",
    cloud: "https://live20.bozztv.com/giatvplayout7/giatv-208566/tracks-v1a1/mono.ts.m3u8"
  }
};

// CORS global
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,HEAD,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Range");
  next();
});

// Proxy playlist.m3u8
app.get("/proxy/:channel/playlist.m3u8", async (req, res) => {
  const { channel } = req.params;
  const config = channels[channel];
  if (!config) return res.status(404).send("Canal no encontrado");

  let playlistUrl = config.cloud;
  try {
    const headRes = await fetch(config.live, { method: "HEAD" });
    if (headRes.ok) playlistUrl = config.live;
  } catch {}

  const r = await fetch(playlistUrl);
  let text = await r.text();
  text = text.replace(/(.*?\.ts)/g, `/proxy/${channel}/$1`);

  res.header("Content-Type", "application/vnd.apple.mpegurl");
  res.send(text);
});

// Proxy segmentos .ts
Object.keys(channels).forEach((channel) => {
  const config = channels[channel];
  const baseUrl = config.cloud.substring(0, config.cloud.lastIndexOf("/") + 1);

  app.use(`/proxy/${channel}/`, createProxyMiddleware({
    target: baseUrl,
    changeOrigin: true,
    pathRewrite: { [`^/proxy/${channel}/`]: "" },
    onProxyRes: (proxyRes, req, res) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Range");
      res.setHeader("Accept-Ranges", "bytes");
    }
  }));
});

app.listen(PORT, () => console.log(`✅ Proxy HLS corriendo en http://localhost:${PORT}`));
