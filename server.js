import events from "events";
events.EventEmitter.defaultMaxListeners = 1000000;

import express from "express";
import fetch from "node-fetch";
import https from "https";

const app = express();
const PORT = process.env.PORT || 8080;

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

// ------------------- CHEQUEO DE STREAM -------------------
async function checkLive(channel, url) {
  try {
    const resp = await fetch(url, { headers: { Range: "bytes=0-200" }, agent: new https.Agent({ rejectUnauthorized: false }) });
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

// ------------------- PLAYLIST PROXY -------------------
app.get("/proxy/:channel/playlist.m3u8", async (req, res) => {
  const { channel } = req.params;
  const config = channels[channel];
  if (!config) return res.status(404).send("Canal no encontrado");

  const playlistUrl = channelStatus[channel].live ? config.live : config.cloud;

  try {
    const response = await fetch(playlistUrl, { 
      headers: { "User-Agent": "VLC/3.0", "Accept": "*/*" }, 
      agent: new https.Agent({ rejectUnauthorized: false })
    });
    let text = await response.text();

    // Reescribir segmentos relativos para pasar por proxy
    text = text.replace(/^(?!#)(.*\.ts)$/gm, (line) => {
      if (line.startsWith("http")) return line;
      return `/proxy/${channel}/segments/${line}`;
    });

    PLAYLIST_CACHE[channel] = text;

    res.header("Content-Type", "application/vnd.apple.mpegurl");
    res.header("Accept-Ranges", "bytes");
    res.send(text);
  } catch (err) {
    console.error(err);
    res.header("Content-Type", "application/vnd.apple.mpegurl");
    res.send(PLAYLIST_CACHE[channel]);
  }
});

// ------------------- SEGMENTOS PROXY -------------------
app.use("/proxy/:channel/segments/", async (req, res) => {
  const { channel } = req.params;
  const config = channels[channel];
  if (!config) return res.status(404).send("Canal no encontrado");

  const baseUrl = new URL(channelStatus[channel].live ? config.live : config.cloud);
  baseUrl.pathname = baseUrl.pathname.substring(0, baseUrl.pathname.lastIndexOf("/") + 1);

  const segmentPath = req.path.replace(`/proxy/${channel}/segments/`, "");
  const targetUrl = `${baseUrl.toString()}${segmentPath}`;

  try {
    const response = await fetch(targetUrl, { 
      headers: { 
        "User-Agent": "VLC/3.0", 
        "Accept": "*/*", 
        "Range": req.headers.range || "bytes=0-" 
      }, 
      agent: new https.Agent({ rejectUnauthorized: false })
    });

    res.status(response.status);
    response.headers.forEach((value, key) => res.setHeader(key, value));
    response.body.pipe(res);
  } catch (err) {
    console.error(err);
    res.status(500).send("Error al obtener segmento");
  }
});

// ------------------- ESTADO DEL CANAL -------------------
app.get("/status/:channel", (req, res) => {
  const { channel } = req.params;
  if (!channels[channel]) return res.status(404).send({ error: "Canal no encontrado" });
  res.send({ live: channelStatus[channel].live });
});

app.listen(PORT, () => console.log(`✅ Proxy HLS listo en http://localhost:${PORT}`));
