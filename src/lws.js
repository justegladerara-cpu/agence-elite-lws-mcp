// Outils qui passent par l'API LWS (compte de Juste). Actifs seulement si LWS_LOGIN et LWS_CLE sont dans les secrets du serveur.
// API : https://api.lws.net/v1, en-têtes X-Auth-Login / X-Auth-Pass, réponse { code, info, data }.
// Zone DNS : GET/POST/DELETE /domain/{domaine}/zdns (ligne : { id, type, name, value, ttl }).
// LWS n'accepte la clé que depuis les adresses IP autorisées dans panel.lws.fr › Api LWS.
import { normaliserNom } from './outils.js';

const BASE = 'https://api.lws.net/v1';
const TYPES_MODIFIABLES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT'];
const TTLS = [900, 1800, 3600, 7200, 21600, 43200, 86400];
const VALIDITE_MS = 15 * 60 * 1000;

export const lwsActif = (env) => Boolean(env?.LWS_LOGIN && env?.LWS_CLE);
const modifiables = (env) =>
  String(env?.LWS_DOMAINES_MODIFIABLES || 'agence-elite.fr').split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);

export async function appelLws(env, methode, chemin, corps, f = fetch) {
  const entetes = {
    accept: 'application/json',
    'content-type': 'application/json',
    'X-Auth-Login': env.LWS_LOGIN,
    'X-Auth-Pass': env.LWS_CLE,
  };
  if (env.LWS_MODE_TEST === '1') entetes['X-Test-Mode'] = 'true';
  const rep = await f(`${env.LWS_API_BASE || BASE}${chemin}`, {
    method: methode,
    headers: entetes,
    body: corps === undefined ? undefined : JSON.stringify(corps),
  });
  const texte = await rep.text();
  let json;
  try {
    json = JSON.parse(texte);
  } catch {
    throw new Error(`Réponse LWS illisible (HTTP ${rep.status})`);
  }
  if (json.code !== 200) {
    const info = typeof json.info === 'string' ? json.info : JSON.stringify(json.info ?? json);
    const ip = rep.status === 401 || rep.status === 403 || /ip/i.test(info) ? ' (vérifie que l\'IP du serveur est autorisée dans panel.lws.fr › Api LWS)' : '';
    throw new Error(`LWS a refusé : code ${json.code}, ${info}${ip}`);
  }
  return json.data;
}

const zone = (env, d, f) => appelLws(env, 'GET', `/domain/${encodeURIComponent(d)}/zdns`, undefined, f);

// Code de confirmation : signature HMAC du plan exact + date d'expiration, avec un secret du serveur.
async function signer(env, texte) {
  const secret = env.CONFIRMATION_SECRET || `${env.LWS_CLE}:${env.MCP_JETON || ''}`;
  const cle = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', cle, new TextEncoder().encode(texte));
  return [...new Uint8Array(sig)].map((o) => o.toString(16).padStart(2, '0')).join('').slice(0, 32);
}
const canonique = (plan) => JSON.stringify([plan.domaine, plan.action, plan.avant, plan.apres, plan.expire_le]);

function ttlValide(ttl) {
  const n = Number(ttl) || 3600;
  return TTLS.reduce((meilleur, v) => (Math.abs(v - n) < Math.abs(meilleur - n) ? v : meilleur), TTLS[0]);
}

function ligneDemandee(args) {
  const type = String(args.type || '').toUpperCase();
  if (!TYPES_MODIFIABLES.includes(type)) throw new Error(`Type modifiable : ${TYPES_MODIFIABLES.join(', ')}`);
  const nom = String(args.nom ?? '').trim().toLowerCase();
  if (!/^(@|\*|[a-z0-9_*]([a-z0-9_.-]*[a-z0-9])?)$/.test(nom)) throw new Error('Nom invalide : utilise « @ » pour le domaine nu, ou le sous-domaine seul (ex. « crm »)');
  const valeur = String(args.valeur ?? '').trim();
  if (!valeur || valeur.length > 2000) throw new Error('Valeur manquante ou trop longue');
  return { type, name: nom, value: valeur, ttl: ttlValide(args.ttl) };
}

export async function preparerModification(env, args, f = fetch) {
  const d = normaliserNom(args.domaine);
  if (!modifiables(env).includes(d)) throw new Error(`Modification interdite sur ${d} (autorisés : ${modifiables(env).join(', ')})`);
  const action = String(args.action || '');
  if (!['ajouter', 'modifier', 'supprimer'].includes(action)) throw new Error('action : ajouter, modifier ou supprimer');
  const lignes = await zone(env, d, f);
  let avant = null;
  if (action !== 'ajouter') {
    avant = lignes.find((l) => String(l.id) === String(args.id));
    if (!avant) throw new Error(`Aucune ligne avec l'id ${args.id} dans la zone de ${d} (lis-la avec lws_zone_dns)`);
    avant = { id: avant.id, type: avant.type, name: avant.name, value: avant.value, ttl: avant.ttl };
  }
  const apres = action === 'supprimer' ? null : ligneDemandee(args);
  const plan = { domaine: d, action, avant, apres, expire_le: new Date(Date.now() + VALIDITE_MS).toISOString() };
  return {
    ...plan,
    code_confirmation: await signer(env, canonique(plan)),
    a_faire:
      'RIEN N\'EST ENCORE MODIFIÉ. Montre ce plan à Juste en français simple (avant → après) et demande-lui une confirmation explicite. ' +
      'Seulement s\'il répond oui, appelle lws_dns_appliquer avec ce plan tel quel et confirmation « OUI ». Valable 15 minutes.',
  };
}

export async function appliquerModification(env, args, f = fetch) {
  if (args.confirmation !== 'OUI') throw new Error('Confirmation absente : il faut l\'accord explicite de Juste, puis confirmation « OUI »');
  const plan = args.plan || {};
  if (!plan.code_confirmation || plan.code_confirmation !== (await signer(env, canonique(plan))))
    throw new Error('Plan modifié ou code invalide : refais lws_dns_preparer');
  if (Date.parse(plan.expire_le) < Date.now()) throw new Error('Plan expiré (15 minutes) : refais lws_dns_preparer');
  if (!modifiables(env).includes(plan.domaine)) throw new Error('Domaine non modifiable');
  const chemin = `/domain/${encodeURIComponent(plan.domaine)}/zdns`;

  if (plan.avant) {
    const actuel = (await zone(env, plan.domaine, f)).find((l) => String(l.id) === String(plan.avant.id));
    if (!actuel || actuel.value !== plan.avant.value || actuel.name !== plan.avant.name)
      throw new Error('La zone a changé depuis la préparation : refais lws_dns_preparer');
  }
  if (plan.action === 'ajouter') {
    const cree = await appelLws(env, 'POST', chemin, plan.apres, f);
    return { fait: true, action: 'ajouté', ligne: cree ?? plan.apres };
  }
  await appelLws(env, 'DELETE', chemin, { id: plan.avant.id }, f);
  if (plan.action === 'supprimer') return { fait: true, action: 'supprimé', ligne: plan.avant };
  try {
    const cree = await appelLws(env, 'POST', chemin, plan.apres, f);
    return { fait: true, action: 'modifié', avant: plan.avant, apres: cree ?? plan.apres };
  } catch (e) {
    const { id, ...ancienne } = plan.avant;
    await appelLws(env, 'POST', chemin, ancienne, f).catch(() => {});
    throw new Error(`Échec de la nouvelle valeur, ancienne ligne remise en place : ${e.message}`);
  }
}

const CHEMIN_LECTURE = /^\/[a-z0-9][a-z0-9._\-/]*$/i;

export const OUTILS_LWS = [
  {
    name: 'lws_zone_dns',
    description: 'Lit la zone DNS complète d\'un domaine dans le compte LWS (avec l\'id de chaque ligne, nécessaire pour modifier). Lecture seule.',
    inputSchema: { type: 'object', properties: { domaine: { type: 'string', description: 'ex. agence-elite.fr' } }, required: ['domaine'] },
    annotations: { readOnlyHint: true },
    executer: (args, f, env) => zone(env, normaliserNom(args.domaine), f).then((lignes) => ({ domaine: normaliserNom(args.domaine), lignes })),
  },
  {
    name: 'lws_infos_domaine',
    description: 'Informations du compte LWS sur un domaine (état, expiration, renouvellement automatique, services). Lecture seule.',
    inputSchema: { type: 'object', properties: { domaine: { type: 'string', description: 'ex. agence-elite.fr' } }, required: ['domaine'] },
    annotations: { readOnlyHint: true },
    executer: (args, f, env) => appelLws(env, 'GET', `/domain/${encodeURIComponent(normaliserNom(args.domaine))}`, undefined, f),
  },
  {
    name: 'lws_lecture',
    description:
      'Lecture libre (GET uniquement) dans l\'API LWS, pour tout ce qui n\'a pas d\'outil dédié : hébergements, services, compte, solde, factures. ' +
      'Chemin relatif à https://api.lws.net/v1, ex. « /domain/agence-elite.fr ». Documentation : https://api.lws.fr/api-client/lws-client-api. Ne modifie rien.',
    inputSchema: { type: 'object', properties: { chemin: { type: 'string', description: 'ex. /domain/agence-elite.fr' } }, required: ['chemin'] },
    annotations: { readOnlyHint: true },
    executer: (args, f, env) => {
      const c = String(args.chemin || '').trim();
      if (!CHEMIN_LECTURE.test(c) || c.includes('..')) throw new Error('Chemin invalide (ex. /domain/agence-elite.fr)');
      return appelLws(env, 'GET', c, undefined, f);
    },
  },
  {
    name: 'lws_dns_preparer',
    description:
      'Prépare une modification DNS (ajouter, modifier ou supprimer une ligne) SANS rien changer : renvoie le plan avant → après et un code de confirmation. ' +
      'Pour modifier ou supprimer, donne l\'id lu avec lws_zone_dns. Nom : « @ » pour le domaine nu, sinon le sous-domaine seul.',
    inputSchema: {
      type: 'object',
      properties: {
        domaine: { type: 'string' },
        action: { type: 'string', enum: ['ajouter', 'modifier', 'supprimer'] },
        id: { type: ['integer', 'string'], description: 'id de la ligne (modifier, supprimer)' },
        type: { type: 'string', enum: TYPES_MODIFIABLES },
        nom: { type: 'string', description: '« @ », « crm », « www »…' },
        valeur: { type: 'string', description: 'ex. agence-elite-crm.pages.dev ou 1.2.3.4' },
        ttl: { type: 'integer', description: 'secondes (défaut 3600)' },
      },
      required: ['domaine', 'action'],
    },
    annotations: { readOnlyHint: true },
    executer: (args, f, env) => preparerModification(env, args, f),
  },
  {
    name: 'lws_dns_appliquer',
    description:
      'Applique un plan préparé par lws_dns_preparer. À appeler UNIQUEMENT après l\'accord explicite de Juste sur ce plan précis. ' +
      'Passe le plan tel quel (avec code_confirmation) et confirmation « OUI ».',
    inputSchema: {
      type: 'object',
      properties: { plan: { type: 'object', description: 'le résultat complet de lws_dns_preparer' }, confirmation: { type: 'string', enum: ['OUI'] } },
      required: ['plan', 'confirmation'],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    executer: (args, f, env) => appliquerModification(env, args, f),
  },
];
