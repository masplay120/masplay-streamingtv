import express from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import fetch from "node-fetch";

const app = express();

const channels = {
  mixtv: {
    live: "https://live20.bozztv.com/giatv/giatv-estacionmixtv/estacionmixtv/playlist.m3u8",
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


app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,HEAD,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Range");
  next();
});

async function isLive(url) {
  try {
    const res = await fetch(url, { method: "HEAD", timeout: 3000 });
    return res.ok;
  } catch {
    return false;
  }
}

app.use("/proxy/:channel", async (req, res, next) => {
  const { channel } = req.params;
  const config = channels[channel];

  if (!config) return res.status(404).send("Canal no encontrado");

  const liveAvailable = await isLive(config.live);
  const baseTarget = liveAvailable ? config.live : config.cloud;

  const urlObj = new URL(baseTarget);
  const baseUrl = `${urlObj.protocol}//${urlObj.host}${urlObj.pathname.substring(0, urlObj.pathname.lastIndexOf('/') + 1)}`;

  req.proxyTarget = baseTarget;
  req.proxyBase = baseUrl;
  next();
}, (req, res, next) => {
  createProxyMiddleware({
    target: req.proxyBase,
    changeOrigin: true,
    selfHandleResponse: false,
    pathRewrite: (path, req) => path.replace(/^\/proxy\/[^/]+/, ""),
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
