import express from "express";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 8080;

// Canales configurados
const channels = {
  mixtv: {
    live: "https://live20.bozztv.com/giatv/giatv-estacionmixtv/estacionmixtv/chunks.m3u8",
    cloud: "https://live20.bozztv.com/giatvplayout7/giatv-208566/tracks-v1a1/mono.ts.m3u8"
  }
};

// Caché de playlists para suavizar cambios
const playlistCache = {};

// CORS
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,HEAD,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Range");
  next();
});

// 📺 Endpoint playlist.m3u8 (con fallback y caché)
app.get("/proxy/:channel/playlist.m3u8", async (req, res) => {
  const { channel } = req.params;
  const config = channels[channel];
  if (!config) return res.status(404).send("Canal no encontrado");

  let playlistUrl = config.cloud;

  try {
    // Probar si live está activo
    const liveResp = await fetch(config.live, { method: "HEAD", timeout: 2000 });
    if (liveResp.ok) playlistUrl = config.live;
  } catch {}

  try {
    const response = await fetch(playlistUrl);
    if (response.ok) {
      let text = await response.text();
      // Reescribir segmentos
      text = text.replace(/(.*?\.ts)/g, `/proxy/${channel}/$1`);
      playlistCache[channel] = text; // actualizar caché
    }
  } catch (err) {
    console.error(`Error obteniendo playlist de ${channel}:`, err.message);
  }

  // Servir desde cache si no hay nueva
  if (!playlistCache[channel]) {
    return res.status(503).send("Playlist no disponible");
  }

  res.header("Content-Type", "application/vnd.apple.mpegurl");
  res.send(playlistCache[channel]);
});

// 🎞️ Endpoint de segmentos .ts (proxy manual sin cortar)
app.get("/proxy/:channel/:segment", async (req, res) => {
  const { channel, segment } = req.params;
  const config = channels[channel];
  if (!config) return res.status(404).send("Canal no encontrado");

  // Determinar baseUrl (live si responde, si no cloud)
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

    // Encabezados CORS y streaming transparente
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
