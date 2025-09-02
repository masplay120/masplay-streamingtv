import express from "express";
import fetch from "node-fetch";
import { createProxyMiddleware } from "http-proxy-middleware";

const app = express();
const PORT = process.env.PORT || 8080;

// 🔹 Configura tus canales aquí
const channels = {
  mixtv: {
    live: "https://live20.bozztv.com/giatv/giatv-estacionmixtv/estacionmixtv/playlist.m3u8",
    cloud: "https://live20.bozztv.com/giatvplayout7/giatv-208566/tracks-v1a1/mono.ts.m3u8"
  },
  otrocanal: {
    live: "https://example.com/otrocanal/live.m3u8",
    cloud: "https://example.com/otrocanal/vod.m3u8"
  }
};

// 🔹 CORS global
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,HEAD,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Range");
  next();
});

// 🔹 Endpoint para playlist.m3u8
app.get("/proxy/:channel/playlist.m3u8", async (req, res) => {
  const { channel } = req.params;
  const config = channels[channel];
  if (!config) return res.status(404).send("Canal no encontrado");

  // Elegir live si está disponible
  let playlistUrl = config.cloud;
  try {
    const headRes = await fetch(config.live, { method: "HEAD" });
    if (headRes.ok) playlistUrl = config.live;
  } catch {}

  // Obtener playlist
  const r = await fetch(playlistUrl);
  let text = await r.text();

  // Reescribir rutas de segmentos .ts para pasar por el proxy
  text = text.replace(/(.*?\.ts)/g, `/proxy/${channel}/$1`);

  res.header("Content-Type", "application/vnd.apple.mpegurl");
  res.send(text);
});

// 🔹 Endpoint dinámico para segmentos .ts
app.use("/proxy/:channel/:segment", async (req, res, next) => {
  const { channel } = req.params;
  const config = channels[channel];
  if (!config) return res.status(404).send("Canal no encontrado");

  // Elegir baseUrl según si live está disponible
  let baseUrl = config.cloud.substring(0, config.cloud.lastIndexOf("/") + 1);
  try {
    const headRes = await fetch(config.live, { method: "HEAD" });
    if (headRes.ok) baseUrl = config.live.substring(0, config.live.lastIndexOf("/") + 1);
  } catch {}

  // Proxy dinámico
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

// 🔹 Iniciar servidor
app.listen(PORT, () => {
  console.log(`✅ Proxy HLS corriendo en http://localhost:${PORT}`);
});
