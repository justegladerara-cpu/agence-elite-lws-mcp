// Serveur MCP « Agence Elite LWS » (transport Streamable HTTP, sans état) pour Cloudflare Workers.
// Point d'entrée : POST /mcp (JSON-RPC 2.0). Utilisable depuis Claude (connecteur personnalisé) et ChatGPT.
import { OUTILS } from './outils.js';

const VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const INFO = { name: 'agence-elite-lws', title: 'Agence Elite — Domaines LWS', version: '0.1.0' };
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, GET, OPTIONS',
  'access-control-allow-headers': 'content-type, accept, authorization, mcp-protocol-version, mcp-session-id',
};

const json = (corps, statut = 200) =>
  new Response(JSON.stringify(corps), { status: statut, headers: { 'content-type': 'application/json', ...CORS } });
const erreur = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

export async function traiter(msg, f = fetch) {
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return erreur(msg?.id, -32600, 'Requête invalide');
  const { id, method, params = {} } = msg;
  if (id === undefined) return null; // notification (ex. notifications/initialized) : pas de réponse

  switch (method) {
    case 'initialize': {
      const demande = params.protocolVersion;
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: VERSIONS.includes(demande) ? demande : VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: INFO,
          instructions:
            'Connecteur en lecture seule des domaines d\'Agence Elite (DNS publics, sous-domaines, renouvellement). ' +
            'Il ne modifie rien. Réponds à Juste en français simple.',
        },
      };
    }
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };
    case 'tools/list':
      return {
        jsonrpc: '2.0',
        id,
        result: { tools: OUTILS.map(({ executer, ...o }) => o) },
      };
    case 'tools/call': {
      const outil = OUTILS.find((o) => o.name === params.name);
      if (!outil) return erreur(id, -32602, `Outil inconnu : ${params.name}`);
      try {
        const resultat = await outil.executer(params.arguments || {}, f);
        return {
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: JSON.stringify(resultat, null, 2) }], structuredContent: resultat },
        };
      } catch (e) {
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Erreur : ${e.message}` }], isError: true } };
      }
    }
    default:
      return erreur(id, -32601, `Méthode non prise en charge : ${method}`);
  }
}

export default {
  async fetch(requete) {
    const url = new URL(requete.url);
    if (requete.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (url.pathname === '/' && requete.method === 'GET')
      return json({ ...INFO, mcp: `${url.origin}/mcp`, outils: OUTILS.map((o) => o.name), mode: 'lecture seule' });
    if (url.pathname !== '/mcp') return json({ erreur: 'introuvable' }, 404);
    if (requete.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST', ...CORS } });

    let corps;
    try {
      corps = await requete.json();
    } catch {
      return json(erreur(null, -32700, 'JSON illisible'), 400);
    }
    if (Array.isArray(corps)) {
      const reponses = (await Promise.all(corps.map((m) => traiter(m)))).filter(Boolean);
      return reponses.length ? json(reponses) : new Response(null, { status: 202, headers: CORS });
    }
    const reponse = await traiter(corps);
    return reponse ? json(reponse) : new Response(null, { status: 202, headers: CORS });
  },
};
