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
app.use("/proxy/:channel/:segment", async (req, res, next) => {
  const { channel } = req.params;
  const config = channels[channel];
  if (!config) return res.status(404).send("Canal no encontrado");

  let baseUrl = config.cloud.substring(0, config.cloud.lastIndexOf("/") + 1);

  try {
    const headRes = await fetch(config.live, { method: "HEAD" });
    if (headRes.ok) {
      baseUrl = config.live.substring(0, config.live.lastIndexOf("/") + 1);
    }
  } catch {}

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
