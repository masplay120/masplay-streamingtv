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
  ,Canal9envivo: {
    live: "https://usher.ttvnw.net/api/channel/hls/elnueveenvivo.m3u8?acmb=eyJBcHBWZXJzaW9uIjoiZWQ0NjcyMWEtMjlkZC00MGYwLWIyZTktYzk0OGZlYzE3OTYwIn0%3D&allow_source=true&browser_family=chrome&browser_version=140.0&cdm=wv&enable_score=true&fast_bread=true&include_unavailable=true&os_name=Windows&os_version=NT%2010.0&p=8104099&parent_domains=twitchplayer&platform=web&play_session_id=975a5772fb52f6b1265f800767e28d5a&player_backend=mediaplayer&player_version=1.45.0-rc.1&playlist_include_framerate=true&reassignments_supported=true&sig=580c5c35ade499f48f80486ccf57cb058b3a56f0&supported_codecs=av1,h264&token=%7B%22adblock%22%3Afalse%2C%22authorization%22%3A%7B%22forbidden%22%3Afalse%2C%22reason%22%3A%22%22%7D%2C%22blackout_enabled%22%3Afalse%2C%22channel%22%3A%22elnueveenvivo%22%2C%22channel_id%22%3A1307193798%2C%22chansub%22%3A%7B%22restricted_bitrates%22%3A%5B%5D%2C%22view_until%22%3A1924905600%7D%2C%22ci_gb%22%3Afalse%2C%22geoblock_reason%22%3A%22%22%2C%22device_id%22%3A%229e3a9d7d1eca39f2%22%2C%22expires%22%3A1757286356%2C%22extended_history_allowed%22%3Afalse%2C%22game%22%3A%22%22%2C%22hide_ads%22%3Afalse%2C%22https_required%22%3Atrue%2C%22mature%22%3Afalse%2C%22partner%22%3Afalse%2C%22platform%22%3A%22web%22%2C%22player_type%22%3A%22embed%22%2C%22private%22%3A%7B%22allowed_to_view%22%3Atrue%7D%2C%22privileged%22%3Afalse%2C%22role%22%3A%22%22%2C%22server_ads%22%3Atrue%2C%22show_ads%22%3Atrue%2C%22subscriber%22%3Afalse%2C%22turbo%22%3Afalse%2C%22user_id%22%3Anull%2C%22user_ip%22%3A%22190.183.0.107%22%2C%22version%22%3A3%2C%22maximum_resolution%22%3A%22FULL_HD%22%2C%22maximum_video_bitrate_kbps%22%3A12500%2C%22maximum_resolution_reasons%22%3A%7B%22QUAD_HD%22%3A%5B%22AUTHZ_NOT_LOGGED_IN%22%5D%2C%22ULTRA_HD%22%3A%5B%22AUTHZ_NOT_LOGGED_IN%22%5D%7D%2C%22maximum_video_bitrate_kbps_reasons%22%3A%5B%22AUTHZ_DISALLOWED_BITRATE%22%5D%7D&transcode_mode=cbr_v1",
    cloud: "https://masplay-streamingtv.onrender.com/proxy/Canal9envivo/playlist.m3u8"
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
