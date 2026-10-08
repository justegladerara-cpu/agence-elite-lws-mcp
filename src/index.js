// Serveur MCP « Agence Elite LWS » (transport Streamable HTTP, sans état) pour Cloudflare Workers.
// Point d'entrée : POST /mcp (JSON-RPC 2.0). Utilisable depuis Claude (connecteur personnalisé) et ChatGPT.
import { OUTILS } from './outils.js';
import { OUTILS_LWS, lwsActif } from './lws.js';
import { OUTILS_CF, cfActif } from './cloudflare.js';

const VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const INFO = { name: 'agence-elite-lws', title: 'Agence Elite — Domaines LWS', version: '0.3.0' };
const outils = (env) => [...OUTILS, ...(cfActif(env) ? OUTILS_CF : []), ...(lwsActif(env) ? OUTILS_LWS : [])];
const protege = (env) => lwsActif(env) || cfActif(env);
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, GET, OPTIONS',
  'access-control-allow-headers': 'content-type, accept, authorization, mcp-protocol-version, mcp-session-id',
};

const json = (corps, statut = 200) =>
  new Response(JSON.stringify(corps), { status: statut, headers: { 'content-type': 'application/json', ...CORS } });
const erreur = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

export async function traiter(msg, f = fetch, env = {}) {
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
            'Connecteur des domaines d\'Agence Elite (DNS, sous-domaines, renouvellement, adresses clients, compte LWS). Réponds à Juste en français simple. ' +
            'Toute modification DNS passe par lws_dns_preparer, puis l\'accord explicite de Juste, puis lws_dns_appliquer. Jamais sans son oui.',
        },
      };
    }
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };
    case 'tools/list':
      return {
        jsonrpc: '2.0',
        id,
        result: { tools: outils(env).map(({ executer, ...o }) => o) },
      };
    case 'tools/call': {
      const outil = outils(env).find((o) => o.name === params.name);
      if (!outil) return erreur(id, -32602, `Outil inconnu : ${params.name}`);
      try {
        const resultat = await outil.executer(params.arguments || {}, f, env);
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
  async fetch(requete, env = {}) {
    const url = new URL(requete.url);
    // Avec MCP_JETON (obligatoire dès qu'une clé LWS ou Cloudflare est configurée), l'adresse devient /mcp/<jeton> : elle sert de mot de passe.
    const jeton = env.MCP_JETON || '';
    if (protege(env) && jeton.length < 24) return json({ erreur: 'MCP_JETON manquant ou trop court (24 caractères minimum)' }, 500);
    const chemin = jeton ? `/mcp/${jeton}` : '/mcp';
    if (requete.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (url.pathname === '/' && requete.method === 'GET')
      return json({ ...INFO, outils: outils(env).length, mode: protege(env) ? 'complet' : 'lecture seule' });
    if (url.pathname !== chemin) return json({ erreur: 'introuvable' }, 404);
    if (requete.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST', ...CORS } });

    let corps;
    try {
      corps = await requete.json();
    } catch {
      return json(erreur(null, -32700, 'JSON illisible'), 400);
    }
    if (Array.isArray(corps)) {
      const reponses = (await Promise.all(corps.map((m) => traiter(m, fetch, env)))).filter(Boolean);
      return reponses.length ? json(reponses) : new Response(null, { status: 202, headers: CORS });
    }
    const reponse = await traiter(corps, fetch, env);
    return reponse ? json(reponse) : new Response(null, { status: 202, headers: CORS });
  },
};
