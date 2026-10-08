// Lancement sur un serveur classique (VPS à IP fixe, exigée par LWS) : node src/serveur-node.js
// Variables d'environnement : LWS_LOGIN, LWS_CLE, MCP_JETON, PORT (défaut 8787), LWS_DOMAINES_MODIFIABLES.
import http from 'node:http';
import worker from './index.js';

const port = Number(process.env.PORT || 8787);

http
  .createServer(async (req, res) => {
    try {
      const morceaux = [];
      for await (const m of req) morceaux.push(m);
      const corps = Buffer.concat(morceaux);
      const requete = new Request(`http://${req.headers.host || 'localhost'}${req.url}`, {
        method: req.method,
        headers: req.headers,
        body: ['GET', 'HEAD', 'OPTIONS'].includes(req.method) ? undefined : corps,
      });
      const reponse = await worker.fetch(requete, process.env);
      res.writeHead(reponse.status, Object.fromEntries(reponse.headers));
      res.end(Buffer.from(await reponse.arrayBuffer()));
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ erreur: e.message }));
    }
  })
  .listen(port, () => console.log(`Connecteur Agence Elite LWS sur le port ${port}`));
