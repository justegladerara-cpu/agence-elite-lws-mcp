// Sous-domaines clients (ex. thedream.agence-elite.fr) branchés sur la plateforme hébergée par Cloudflare Pages.
// Prérequis faits une seule fois par Juste : chez LWS une ligne CNAME « * » vers le projet Pages, et dans les secrets
// du serveur CF_API_TOKEN (droit « Cloudflare Pages : Modifier »). CF_ACCOUNT_ID est facultatif (trouvé avec le jeton). Aucune IP fixe nécessaire.
import { normaliserNom, resoudre } from './outils.js';

const API = 'https://api.cloudflare.com/client/v4';
const DOMAINE = 'agence-elite.fr';
const RESERVES = ['www', 'crm', 'saas', 'mail', 'site', 'lws', 'api', 'admin', 'smtp', 'imap', 'pop', 'webmail', 'ftp'];

export const cfActif = (env) => Boolean(env?.CF_API_TOKEN);
const projet = (env) => env.CF_PROJET || 'agence-elite-saas';

async function requeteCf(env, methode, url, corps, f) {
  const rep = await f(url, {
    method: methode,
    headers: { authorization: `Bearer ${env.CF_API_TOKEN}`, 'content-type': 'application/json' },
    body: corps === undefined ? undefined : JSON.stringify(corps),
  });
  const json = await rep.json().catch(() => ({}));
  if (!json.success) {
    const msg = (json.errors || []).map((e) => e.message).join(' ; ') || `HTTP ${rep.status}`;
    throw new Error(`Cloudflare a refusé : ${msg}`);
  }
  return json.result;
}

async function compte(env, f) {
  if (env.CF_ACCOUNT_ID) return env.CF_ACCOUNT_ID;
  const comptes = await requeteCf(env, 'GET', `${API}/accounts`, undefined, f);
  if (comptes?.length !== 1) throw new Error('Plusieurs comptes Cloudflare (ou aucun) : ajoute la variable CF_ACCOUNT_ID');
  return comptes[0].id;
}

async function appelCf(env, methode, chemin, corps, f = fetch) {
  return requeteCf(env, methode, `${API}/accounts/${await compte(env, f)}/pages/projects/${projet(env)}${chemin}`, corps, f);
}

function nomComplet(sousDomaine) {
  const s = String(sousDomaine ?? '').trim().toLowerCase().replace(new RegExp(`\\.${DOMAINE.replace('.', '\\.')}\\.?$`), '');
  if (!/^[a-z0-9]([a-z0-9-]{0,40}[a-z0-9])?$/.test(s)) throw new Error('Sous-domaine invalide : lettres, chiffres et tirets uniquement (ex. « thedream »)');
  if (RESERVES.includes(s)) throw new Error(`« ${s} » est réservé à Agence Elite`);
  return normaliserNom(`${s}.${DOMAINE}`);
}

const resume = (d) => ({
  adresse: `https://${d.name}`,
  etat: d.status === 'active' ? 'actif' : d.status === 'pending' ? 'en cours d\'activation (quelques minutes)' : d.status,
  certificat: d.validation_data?.status ?? null,
});

// Fonctions partagées par le connecteur IA et le bouton du super admin de la plateforme.
export async function listerAdresses(env, f = fetch) {
  return { projet: projet(env), adresses: (await appelCf(env, 'GET', '/domains', undefined, f)).map(resume) };
}

export async function creerAdresse(env, sousDomaine, f = fetch) {
  const nom = nomComplet(sousDomaine);
  const existants = await appelCf(env, 'GET', '/domains', undefined, f);
  const deja = existants.find((d) => d.name === nom);
  const d = deja || (await appelCf(env, 'POST', '/domains', { name: nom }, f));
  const dns = await resoudre(nom, 'CNAME', f).catch(() => null);
  const pointe = dns?.enregistrements?.some((r) => r.type === 'CNAME');
  return {
    ...resume(d),
    deja_existant: Boolean(deja),
    dns: pointe
      ? 'OK'
      : `le nom ne pointe pas encore vers la plateforme : il faut une fois pour toutes la ligne CNAME « * » → ${projet(env)}.pages.dev chez LWS`,
  };
}

export const OUTILS_CF = [
  {
    name: 'lister_sous_domaines_clients',
    description: `Liste les adresses clients branchées sur la plateforme (ex. thedream.${DOMAINE}) et leur état. Lecture seule.`,
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    executer: (_args, f, env) => listerAdresses(env, f),
  },
  {
    name: 'creer_sous_domaine_client',
    description:
      `Crée une adresse client sur la plateforme, ex. « thedream » → https://thedream.${DOMAINE}. ` +
      'Demande d\'abord l\'accord de Juste sur le nom exact, puis appelle avec confirmation « OUI ». Le site est actif en quelques minutes.',
    inputSchema: {
      type: 'object',
      properties: {
        sous_domaine: { type: 'string', description: 'ex. thedream' },
        confirmation: { type: 'string', enum: ['OUI'], description: 'seulement après l\'accord de Juste' },
      },
      required: ['sous_domaine', 'confirmation'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    executer: (args, f, env) => {
      if (args.confirmation !== 'OUI') throw new Error('Il faut l\'accord de Juste, puis confirmation « OUI »');
      return creerAdresse(env, args.sous_domaine, f);
    },
  },
];
