import events from "events";
events.EventEmitter.defaultMaxListeners = 1000000;

import express from "express";
import fetch from "node-fetch";
import { createProxyMiddleware } from "http-proxy-middleware";

const app = express();
const PORT = process.env.PORT || 8080;

// ------------------- CONFIGURACIÓN -------------------
const channels = {
  mixtv: {
    live: "https://streamlive8.hearthis.at/hls/10778826_orig/index.m3u8",
    cloud: "https://live20.bozztv.com/giatvplayout7/giatv-208566/tracks-v1a1/mono.ts.m3u8"
  },
  eltrece: {
    live: "https://livetrx01.vodgc.net/eltrecetv/index.m3u8",
    cloud: "https://masplay-streamingtv.onrender.com/proxy/Canal9envivo/playlist.m3u8"
  },
  pruebas: {
    live: "http://servidorvip.net/rivadera2025/123123456456/384819?m3u8",
    cloud: "http://radio.x10.mx/video/playlist.php?dummy=.m3u8"
  }
};

const channelStatus = {};
const PLAYLIST_CACHE = {};
const CHECK_INTERVAL = 5000;

// Inicializar estados
for (const ch in channels) {
  channelStatus[ch] = { live: false };
  PLAYLIST_CACHE[ch] = "#EXTM3U\n";
}

// ------------------- CHEQUEO DE STREAMS -------------------
async function checkLive(channel, url) {
  try {
    const resp = await fetch(url, { headers: { Range: "bytes=0-200" } });
    channelStatus[channel].live = resp.ok;
  } catch {
    channelStatus[channel].live = false;
  }
}

for (const ch in channels) {
  setInterval(() => checkLive(ch, channels[ch].live), CHECK_INTERVAL);
}

// ------------------- CORS GLOBAL -------------------
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,HEAD,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Range");
  next();
});

// ------------------- ENDPOINT DE PLAYLIST PROXY -------------------
app.get("/proxy/:channel/playlist.m3u8", async (req, res) => {
  const { channel } = req.params;
  const config = channels[channel];
  if (!config) return res.status(404).send("Canal no encontrado");

  const playlistUrl = channelStatus[channel].live ? config.live : config.cloud;

  try {
    const response = await fetch(playlistUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept": "*/*",
        "Range": "bytes=0-"
      }
    });
    let text = await response.text();

    // Reescribir URLs de .ts y .m3u8
    text = text.replace(/^(?!#)(.*)$/gm, (line) => {
      if (line.startsWith("#")) return line;

      if (line.endsWith(".ts")) {
        if (line.startsWith("http")) return `/proxy/${channel}/?url=${encodeURIComponent(line)}`;
        return `/proxy/${channel}/${line}`;
      }

      if (line.endsWith(".m3u8")) {
        if (line.startsWith("http")) return `/proxy/${channel}/?url=${encodeURIComponent(line)}`;
        return `/proxy/${channel}/${line}`;
      }

      return line;
    });

    PLAYLIST_CACHE[channel] = text;

    res.header("Content-Type", "application/vnd.apple.mpegurl");
    res.send(text);
  } catch {
    res.header("Content-Type", "application/vnd.apple.mpegurl");
    res.send(PLAYLIST_CACHE[channel]);
  }
});

// ------------------- ENDPOINT PROXY DE SEGMENTOS Y PLAYLISTS ANIDADAS -------------------
for (const channel in channels) {
  app.use(`/proxy/${channel}/`, (req, res, next) => {
    let targetUrl;

    // Si viene ?url= es una playlist o TS absoluto
    if (req.query.url) {
      targetUrl = decodeURIComponent(req.query.url);
    } else {
      const baseUrl = channelStatus[channel].live ? channels[channel].live : channels[channel].cloud;
      const urlObj = new URL(baseUrl);
      urlObj.pathname = urlObj.pathname.substring(0, urlObj.pathname.lastIndexOf("/") + 1) + req.path.replace(`/${channel}/`, "");
      targetUrl = urlObj.toString();
    }

    createProxyMiddleware({
      target: targetUrl,
      changeOrigin: true,
      selfHandleResponse: false,
      onProxyReq: (proxyReq, req, res) => {
        proxyReq.setHeader("User-Agent", "Mozilla/5.0");
        proxyReq.setHeader("Accept", "*/*");
      },
      pathRewrite: { "^/proxy/": "" },
      logLevel: "error",
      onProxyRes: (proxyRes, req, res) => {
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Range");
        res.setHeader("Accept-Ranges", "bytes");
      }
    })(req, res, next);
  });
}

// ------------------- ENDPOINT OPCIONAL PARA CONSULTAR ESTADO -------------------
app.get("/status/:channel", (req, res) => {
  const { channel } = req.params;
  if (!channels[channel]) return res.status(404).send({ error: "Canal no encontrado" });
  res.json({ live: channelStatus[channel].live });
});

// ------------------- INICIAR SERVIDOR -------------------
app.listen(PORT, () => console.log(`✅ Proxy estable en http://localhost:${PORT}`));
