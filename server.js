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
    live: "https://live20.bozztv.com/giatv/giatv-estacionmixtv/estacionmixtv/chunks.m3u8",
    cloud: "https://live20.bozztv.com/giatvplayout7/giatv-208566/tracks-v1a1/mono.ts.m3u8"
  }
  ,flowsports3: {
    live: "https://edge-live32-sl.cvattv.com.ar/tok_eyJhbGciOiJIUzUxMiIsInR5cCI6IkpXVCJ9.eyJleHAiOiIxNzU3NDU1NTEzIiwic2lwIjoiMTkwLjE4My4wLjEwNyIsInBhdGgiOiIvbGl2ZS9jNGVkcy9FdmVudG9zM19VWS9TQV9MaXZlX2Rhc2hfZW5jX0MvIiwic2Vzc2lvbl9jZG5faWQiOiI5OGVjMjBiMDk4ZTdjZTlhIiwic2Vzc2lvbl9pZCI6IiIsImNsaWVudF9pZCI6IiIsImRldmljZV9pZCI6IiIsIm1heF9zZXNzaW9ucyI6MCwic2Vzc2lvbl9kdXJhdGlvbiI6MCwidXJsIjoiaHR0cHM6Ly8yMDEuMjM1LjY2LjExNSIsImF1ZCI6IjEwMCIsInNvdXJjZXMiOls4NSwxNDQsODYsODhdfQ==.7c8omdIcd5vswI4T-nYlf4s7x46USI3LccanBmSOgYtEcstnXBn8Cw-u7qH7q0OpQ2kbyxEm60gt28fQ1cO9Bg==/live/c4eds/Eventos3_UY/SA_Live_dash_enc_C/Eventos3_UY.mpd",
    cloud: "https://ejemplo.com/canal2/vod/fallback.m3u8"
  },
  canal3: {
    live: "https://ejemplo.com/canal3/live/playlist.m3u8",
    cloud: "https://ejemplo.com/canal3/vod/fallback.m3u8"
  }

};

const channelStatus = {};  // Estado de cada canal
const PLAYLIST_CACHE = {}; // Última playlist en caché
const CHECK_INTERVAL = 2000; // 2 segundos

// Inicializar estados
for (const ch in channels) {
  channelStatus[ch] = { live: false };
  PLAYLIST_CACHE[ch] = "#EXTM3U\n";
}

// ------------------- FUNCIÓN PARA CHEQUEAR SI ESTÁ LIVE -------------------
async function checkLive(channel, url) {
  try {
    const resp = await fetch(url, { method: "HEAD", timeout: 3000 });
    channelStatus[channel].live = resp.ok;
  } catch {
    channelStatus[channel].live = false;
  }
}

// ------------------- CHEQUEO EN INTERVALO -------------------
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

// ------------------- PLAYLIST PROXY -------------------
app.get("/proxy/:channel/playlist.m3u8", async (req, res) => {
  const { channel } = req.params;
  const config = channels[channel];
  if (!config) return res.status(404).send("Canal no encontrado");

  const playlistUrl = channelStatus[channel].live ? config.live : config.cloud;

  try {
    const response = await fetch(playlistUrl);
    let text = await response.text();

    // Reescribir segmentos para que pasen por nuestro proxy
    text = text.replace(/(.*?\.ts)/g, `/proxy/${channel}/$1`);
    PLAYLIST_CACHE[channel] = text;

    res.header("Content-Type", "application/vnd.apple.mpegurl");
    res.send(text);
  } catch {
    // En caso de error, devolver la última playlist en caché
    res.header("Content-Type", "application/vnd.apple.mpegurl");
    res.send(PLAYLIST_CACHE[channel]);
  }
});

// ------------------- PROXY DE SEGMENTOS -------------------
for (const channel in channels) {
  app.use(`/proxy/${channel}/`, (req, res, next) => {
    // Decidir si usar live o cloud **cada request**
    const baseUrl = channelStatus[channel].live ? channels[channel].live : channels[channel].cloud;
    const baseUrlDir = baseUrl.replace(/[^/]+$/, "");

    createProxyMiddleware({
      target: baseUrlDir,
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

// ------------------- ENDPOINT OPCIONAL PARA CONSULTAR ESTADO -------------------
app.get("/status/:channel", (req, res) => {
  const { channel } = req.params;
  if (!channels[channel]) return res.status(404).send({ error: "Canal no encontrado" });
  res.json({ live: channelStatus[channel].live });
});

// ------------------- INICIAR SERVIDOR -------------------
app.listen(PORT, () => console.log(`✅ Proxy estable en http://localhost:${PORT}`));
