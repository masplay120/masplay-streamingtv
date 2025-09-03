import express from "express";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 8080;

// Canales configurados
const channels = {
  mixtv: {
    live: "https://live20.bozztv.com/giatv/giatv-estacionmixtv/estacionmixtv/chunks.m3u8",
    cloud: "https://live20.bozztv.com/giatvplayout7/giatv-208566/tracks-v1a1/mono.ts" // ojo: esto es un .ts único
  }
};

// CORS
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,HEAD,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Range");
  next();
});

// 📺 Endpoint playlist.m3u8
app.get("/proxy/:channel/playlist.m3u8", async (req, res) => {
  const { channel } = req.params;
  const config = channels[channel];
  if (!config) return res.status(404).send("Canal no encontrado");

  let playlistText = null;

  try {
    // probar si live responde
    const liveResp = await fetch(config.live, { method: "HEAD", timeout: 2000 });
    if (liveResp.ok) {
      // usar live
      const response = await fetch(config.live);
      let text = await response.text();
      // reescribir segmentos
      text = text.replace(/(.*?\.ts)/g, `/proxy/${channel}/$1`);
      playlistText = text;
    }
  } catch {}

  if (!playlistText) {
    // fallback: crear playlist falsa con el cloud.ts
    playlistText = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:10
#EXT-X-MEDIA-SEQUENCE:0
#EXTINF:10.0,
${config.cloud.replace(/^.*\//, `/proxy/${channel}/`)}
#EXT-X-ENDLIST`;
  }

  res.header("Content-Type", "application/vnd.apple.mpegurl");
  res.send(playlistText);
});

// 🎞️ Endpoint de segmentos .ts
app.get("/proxy/:channel/:segment", async (req, res) => {
  const { channel, segment } = req.params;
  const config = channels[channel];
  if (!config) return res.status(404).send("Canal no encontrado");

  let baseUrl = config.cloud.substring(0, config.cloud.lastIndexOf("/") + 1);

  try {
    const liveResp = await fetch(config.live, { method: "HEAD", timeout: 2000 });
    if (liveResp.ok) {
      baseUrl = config.live.substring(0, config.live.lastIndexOf("/") + 1);
    }
  } catch {}

  const segmentUrl = baseUrl + segment;

  try {
    const response = await fetch(segmentUrl);
    if (!response.ok) return res.status(502).send("Error en el segmento");

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Range");
    res.setHeader("Accept-Ranges", "bytes");

    response.body.pipe(res);
  } catch (err) {
    console.error(`Error trayendo segmento ${segment}:`, err.message);
    res.status(500).send("Error obteniendo segmento");
  }
});

app.listen(PORT, () => console.log(`✅ Proxy HLS corriendo en http://localhost:${PORT}`));
