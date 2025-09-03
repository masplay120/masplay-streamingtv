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

// CORS
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,HEAD,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Range");
  next();
});

// Función para comprobar si live está disponible
async function isLive(url) {
  try {
    const resp = await fetch(url, { method: "HEAD", timeout: 3000 });
    return resp.ok;
  } catch {
    return false;
  }
}

// Endpoint playlist.m3u8
app.get("/proxy/:channel/playlist.m3u8", async (req, res) => {
  const { channel } = req.params;
  const config = channels[channel];
  if (!config) return res.status(404).send("Canal no encontrado");

  const liveAvailable = await isLive(config.live);
  const playlistUrl = liveAvailable ? config.live : config.cloud;

  const response = await fetch(playlistUrl);
  let text = await response.text();

  // Reescribir rutas de segmentos
  text = text.replace(/(.*?\.ts)/g, `/proxy/${channel}/$1`);

  res.header("Content-Type", "application/vnd.apple.mpegurl");
  res.send(text);
});

// Proxy dinámico para todos los segmentos .ts
app.use("/proxy/:channel/", async (req, res, next) => {
  const { channel } = req.params;
  const config = channels[channel];
  if (!config) return res.status(404).send("Canal no encontrado");

  const liveAvailable = await isLive(config.live);
  const baseUrl = (liveAvailable ? config.live : config.cloud).substring(0, (liveAvailable ? config.live : config.cloud).lastIndexOf("/") + 1);

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

app.listen(PORT, () => console.log(`✅ Proxy HLS corriendo en http://localhost:${PORT}`));
