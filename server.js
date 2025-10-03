import express from "express";
import fetch from "node-fetch";
import { createProxyMiddleware } from "http-proxy-middleware";

const app = express();
const PORT = 8080;

const channels = {
  mixtv: {
    live: "https://streamlive8.hearthis.at/hls/10778826_orig/index.m3u8",
    cloud: "https://live20.bozztv.com/giatvplayout7/giatv-208566/tracks-v1a1/mono.ts.m3u8"
  }
};

// ------------------- CORS -------------------
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,HEAD,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Range");
  next();
});

// ------------------- PLAYLIST -------------------
app.get("/proxy/:channel/playlist.m3u8", async (req, res) => {
  const { channel } = req.params;
  const config = channels[channel];
  if (!config) return res.status(404).send("Canal no encontrado");

  const playlistUrl = config.live;

  try {
    const response = await fetch(playlistUrl, { headers: { "User-Agent": "Mozilla/5.0", "Accept": "*/*" } });
    let text = await response.text();

    // Reescribir segmentos relativos
    text = text.replace(/^(?!#)(.*\.ts)$/gm, (line) => {
      if (line.startsWith("http")) return line; // deja absolutas
      return `/proxy/${channel}/segments/${line}`;
    });

    res.header("Content-Type", "application/vnd.apple.mpegurl");
    res.send(text);
  } catch (err) {
    console.error(err);
    res.status(500).send("Error al obtener playlist");
  }
});

// ------------------- SEGMENTOS -------------------
app.use("/proxy/:channel/segments/", async (req, res, next) => {
  const { channel } = req.params;
  const config = channels[channel];
  if (!config) return res.status(404).send("Canal no encontrado");

  const baseUrl = new URL(config.live);
  baseUrl.pathname = baseUrl.pathname.substring(0, baseUrl.pathname.lastIndexOf("/") + 1);

  // Reconstruir URL del segmento
  const segmentPath = req.path.replace(`/proxy/${channel}/segments/`, "");
  const targetUrl = `${baseUrl.toString()}${segmentPath}`;

  try {
    const response = await fetch(targetUrl, {
      headers: { "User-Agent": "Mozilla/5.0", "Accept": "*/*", "Range": req.headers.range || "bytes=0-" }
    });

    res.status(response.status);
    response.headers.forEach((value, key) => res.setHeader(key, value));
    response.body.pipe(res);
  } catch (err) {
    console.error(err);
    res.status(500).send("Error al obtener segmento");
  }
});

app.listen(PORT, () => console.log(`✅ Proxy corriendo en http://localhost:${PORT}`));
