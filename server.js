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

const channelStatus = {};
const CHECK_INTERVAL = 2000; // 2 segundos

// Inicializar
for (const ch in channels) {
  channelStatus[ch] = { live: false };
}

// ----------------- CHEQUEO LIVE -----------------
async function checkLive(channel, url) {
  try {
    const resp = await fetch(url, { method: "HEAD", timeout: 3000 });
    channelStatus[channel].live = resp.ok;
  } catch {
    channelStatus[channel].live = false;
  }
}

for (const ch in channels) {
  setInterval(() => checkLive(ch, channels[ch].live), CHECK_INTERVAL);
}

// ----------------- CORS -----------------
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,HEAD,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Range");
  next();
});

// ----------------- PLAYLIST UNIFICADA -----------------
app.get("/proxy/:channel/playlist.m3u8", async (req, res) => {
  const { channel } = req.params;
  const config = channels[channel];
  if (!config) return res.status(404).send("Canal no encontrado");

  try {
    // Obtener grabado (cloud)
    const cloudResp = await fetch(config.cloud);
    let cloudText = await cloudResp.text();

    // Si hay live activo, obtener live
    if (channelStatus[channel].live) {
      const liveResp = await fetch(config.live);
      let liveText = await liveResp.text();

      // Eliminar encabezado EXTINF y EXT-X-ENDLIST de live para concatenar
      liveText = liveText.replace(/^#EXTM3U\s*/, "");
      liveText = liveText.replace(/#EXT-X-ENDLIST\s*$/i, "");

      cloudText += liveText; // concatenar live al final
    }

    // Reescribir segmentos para pasar por nuestro proxy
    cloudText = cloudText.replace(/(.*?\.ts)/g, `/proxy/${channel}/$1`);

    res.header("Content-Type", "application/vnd.apple.mpegurl");
    res.send(cloudText);
  } catch (err) {
    res.status(500).send("Error generando playlist");
  }
});

// ----------------- PROXY DE SEGMENTOS -----------------
for (const channel in channels) {
  app.use(`/proxy/${channel}/`, (req, res, next) => {
    const config = channels[channel];
    // decidir base dinámico según si el segmento existe en live o cloud
    let targetBase = channelStatus[channel].live ? config.live : config.cloud;
    const baseDir = targetBase.replace(/[^/]+$/, "");

    createProxyMiddleware({
      target: baseDir,
      changeOrigin: true,
      pathRewrite: { [`^/proxy/${channel}/`]: "" },
      onProxyRes(proxyRes) {
        proxyRes.headers['Access-Control-Allow-Origin'] = "*";
        proxyRes.headers['Access-Control-Allow-Methods'] = "GET,HEAD,OPTIONS";
        proxyRes.headers['Access-Control-Allow-Headers'] = "Origin, X-Requested-With, Content-Type, Accept, Range";
        proxyRes.headers['Accept-Ranges'] = "bytes";
      }
    })(req, res, next);
  });
}

// ----------------- ESTADO OPCIONAL -----------------
app.get("/status/:channel", (req, res) => {
  if (!channels[req.params.channel]) return res.status(404).send({ error: "Canal no encontrado" });
  res.json({ live: channelStatus[req.params.channel].live });
});

// ----------------- INICIAR SERVIDOR -----------------
app.listen(PORT, () => console.log(`✅ Proxy HLS unificado corriendo en http://localhost:${PORT}`));
