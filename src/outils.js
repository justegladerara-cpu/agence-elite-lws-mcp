// Outils du connecteur (phase 1 : lecture seule, données publiques).
// Aucune clé LWS : DNS par DNS-over-HTTPS (Cloudflare), renouvellement par RDAP (registre .fr / IANA).

const DOH = 'https://cloudflare-dns.com/dns-query';
const TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'CAA', 'SOA'];
const NUM_TYPE = { 1: 'A', 2: 'NS', 5: 'CNAME', 6: 'SOA', 15: 'MX', 16: 'TXT', 28: 'AAAA', 257: 'CAA' };

// Configuration attendue d'Agence Elite (voir glade-brain, 06 §E).
export const ATTENDU = {
  'agence-elite.fr': {
    ns: 'lwsdns.com',
    sousDomaines: {
      crm: 'agence-elite-crm.pages.dev',
      saas: 'agence-elite-saas.pages.dev',
    },
  },
};

// « _ » autorisé en début d'étiquette pour _dmarc, _domainkey…
const NOM_VALIDE = /^(?=.{1,253}$)(_?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function normaliserNom(nom) {
  const n = String(nom ?? '').trim().toLowerCase().replace(/\.$/, '');
  if (!NOM_VALIDE.test(n)) throw new Error(`Nom de domaine invalide : « ${nom} »`);
  return n;
}

const sansPoint = (v) => String(v).replace(/\.$/, '').toLowerCase();

export async function resoudre(nom, type, f = fetch) {
  const n = normaliserNom(nom);
  const t = String(type || 'A').toUpperCase();
  if (!TYPES.includes(t)) throw new Error(`Type non pris en charge : ${type} (autorisés : ${TYPES.join(', ')})`);
  const rep = await f(`${DOH}?name=${encodeURIComponent(n)}&type=${t}`, { headers: { accept: 'application/dns-json' } });
  if (!rep.ok) throw new Error(`Résolveur DNS indisponible (HTTP ${rep.status})`);
  const json = await rep.json();
  const codes = { 0: 'OK', 2: 'SERVFAIL', 3: 'NXDOMAIN (le nom n\'existe pas)' };
  return {
    nom: n,
    type: t,
    statut: codes[json.Status] ?? `code ${json.Status}`,
    enregistrements: (json.Answer || []).map((r) => ({
      nom: sansPoint(r.name),
      type: NUM_TYPE[r.type] || String(r.type),
      ttl: r.TTL,
      valeur: r.data,
    })),
  };
}

export async function infosDomaine(domaine, f = fetch) {
  const d = normaliserNom(domaine);
  const rdap = d.endsWith('.fr') ? `https://rdap.nic.fr/domain/${d}` : `https://rdap.org/domain/${d}`;
  const rep = await f(rdap, { headers: { accept: 'application/rdap+json' } });
  if (rep.status === 404) return { domaine: d, existe: false };
  if (!rep.ok) throw new Error(`Registre RDAP indisponible (HTTP ${rep.status})`);
  const json = await rep.json();
  const evt = (a) => (json.events || []).find((e) => e.eventAction === a)?.eventDate ?? null;
  const expiration = evt('expiration');
  const registrar = (json.entities || []).find((e) => (e.roles || []).includes('registrar'));
  const nomRegistrar = registrar?.vcardArray?.[1]?.find((x) => x[0] === 'fn')?.[3] ?? null;
  const jours = expiration ? Math.floor((Date.parse(expiration) - Date.now()) / 86400000) : null;
  return {
    domaine: d,
    existe: true,
    statut: json.status || [],
    enregistre_le: evt('registration'),
    expire_le: expiration,
    jours_restants: jours,
    alerte_renouvellement: jours !== null && jours <= 60,
    registrar: nomRegistrar,
    serveurs_dns: (json.nameservers || []).map((n) => sansPoint(n.ldhName)),
  };
}

// Contrôle complet d'un domaine : chaque vérification donne OK / ATTENTION / PROBLÈME.
export async function verifierDomaine(domaine, f = fetch) {
  const d = normaliserNom(domaine);
  const attendu = ATTENDU[d] || { sousDomaines: {} };
  const controles = [];
  const ajouter = (sujet, etat, detail) => controles.push({ sujet, etat, detail });

  const [ns, a, mx, txt, dmarc, info] = await Promise.all([
    resoudre(d, 'NS', f),
    resoudre(d, 'A', f),
    resoudre(d, 'MX', f),
    resoudre(d, 'TXT', f),
    resoudre(`_dmarc.${d}`, 'TXT', f),
    infosDomaine(d, f).catch((e) => ({ erreur: e.message })),
  ]);

  if (ns.statut.startsWith('NXDOMAIN')) {
    ajouter('Domaine', 'PROBLÈME', 'le domaine ne répond pas dans le DNS');
    return { domaine: d, controles };
  }

  const serveurs = ns.enregistrements.filter((r) => r.type === 'NS').map((r) => sansPoint(r.valeur));
  if (!serveurs.length) ajouter('Serveurs DNS', 'PROBLÈME', 'aucun serveur NS trouvé');
  else if (attendu.ns && !serveurs.every((s) => s.endsWith(attendu.ns)))
    ajouter('Serveurs DNS', 'ATTENTION', `inattendus : ${serveurs.join(', ')} (attendu : *.${attendu.ns})`);
  else ajouter('Serveurs DNS', 'OK', serveurs.join(', '));

  const ips = a.enregistrements.filter((r) => r.type === 'A').map((r) => r.valeur);
  ajouter('Site racine (A)', ips.length ? 'OK' : 'ATTENTION', ips.length ? ips.join(', ') : 'aucune adresse : le domaine nu n\'affiche pas de site');

  const mxs = mx.enregistrements.filter((r) => r.type === 'MX').map((r) => r.valeur);
  ajouter('E-mails (MX)', mxs.length ? 'OK' : 'PROBLÈME', mxs.length ? mxs.join(' ; ') : 'aucun MX : les e-mails ne peuvent pas arriver');

  const txts = txt.enregistrements.map((r) => r.valeur.replace(/^"|"$/g, ''));
  const spf = txts.filter((t) => t.toLowerCase().startsWith('v=spf1'));
  if (!spf.length) ajouter('SPF', 'ATTENTION', 'aucun SPF : risque que les e-mails partent en spam');
  else if (spf.length > 1) ajouter('SPF', 'PROBLÈME', `${spf.length} SPF : il ne doit y en avoir qu'un`);
  else ajouter('SPF', 'OK', spf[0]);

  const dm = dmarc.enregistrements.map((r) => r.valeur.replace(/^"|"$/g, '')).find((t) => t.toLowerCase().startsWith('v=dmarc1'));
  ajouter('DMARC', dm ? 'OK' : 'ATTENTION', dm || 'aucun DMARC (recommandé)');

  for (const [sous, cible] of Object.entries(attendu.sousDomaines || {})) {
    const r = await resoudre(`${sous}.${d}`, 'CNAME', f);
    const val = r.enregistrements.find((x) => x.type === 'CNAME')?.valeur;
    if (!val) ajouter(`${sous}.${d}`, 'PROBLÈME', `aucun CNAME (attendu : ${cible})`);
    else if (sansPoint(val) !== cible) ajouter(`${sous}.${d}`, 'ATTENTION', `pointe vers ${sansPoint(val)} (attendu : ${cible})`);
    else ajouter(`${sous}.${d}`, 'OK', `→ ${cible}`);
  }

  if (info.erreur) ajouter('Renouvellement', 'ATTENTION', `registre illisible : ${info.erreur}`);
  else if (info.expire_le)
    ajouter('Renouvellement', info.alerte_renouvellement ? 'ATTENTION' : 'OK', `expire le ${info.expire_le.slice(0, 10)} (dans ${info.jours_restants} jours)`);

  return { domaine: d, controles };
}

export async function verifierSousDomaines(domaine, sousDomaines, f = fetch) {
  const d = normaliserNom(domaine);
  const liste = (sousDomaines?.length ? sousDomaines : ['www', 'crm', 'saas', 'mail', 'site']).slice(0, 20);
  const resultats = [];
  for (const s of liste) {
    const nom = normaliserNom(`${String(s).toLowerCase()}.${d}`);
    const [c, a] = await Promise.all([resoudre(nom, 'CNAME', f), resoudre(nom, 'A', f)]);
    const cname = c.enregistrements.find((x) => x.type === 'CNAME')?.valeur;
    const ips = a.enregistrements.filter((x) => x.type === 'A').map((x) => x.valeur);
    resultats.push({ nom, existe: Boolean(cname || ips.length), cname: cname ? sansPoint(cname) : null, adresses: ips });
  }
  return { domaine: d, sous_domaines: resultats };
}

export const OUTILS = [
  {
    name: 'dns_lookup',
    description: 'Lit un enregistrement DNS public (A, AAAA, CNAME, MX, TXT, NS, CAA, SOA) d\'un nom de domaine. Lecture seule.',
    inputSchema: {
      type: 'object',
      properties: {
        nom: { type: 'string', description: 'Nom à interroger, ex. crm.agence-elite.fr' },
        type: { type: 'string', enum: TYPES, description: 'Type d\'enregistrement (défaut A)' },
      },
      required: ['nom'],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    executer: (args, f) => resoudre(args.nom, args.type, f),
  },
  {
    name: 'verifier_domaine',
    description: 'Contrôle complet d\'un domaine : serveurs DNS, site racine, e-mails (MX, SPF, DMARC), sous-domaines attendus d\'Agence Elite (crm, saas → Cloudflare Pages) et date de renouvellement. Lecture seule.',
    inputSchema: {
      type: 'object',
      properties: { domaine: { type: 'string', description: 'ex. agence-elite.fr' } },
      required: ['domaine'],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    executer: (args, f) => verifierDomaine(args.domaine, f),
  },
  {
    name: 'verifier_sous_domaines',
    description: 'Indique pour chaque sous-domaine s\'il existe et vers quoi il pointe (CNAME ou adresses IP). Lecture seule.',
    inputSchema: {
      type: 'object',
      properties: {
        domaine: { type: 'string', description: 'ex. agence-elite.fr' },
        sous_domaines: { type: 'array', items: { type: 'string' }, description: 'ex. ["www","crm","saas"] (20 max)' },
      },
      required: ['domaine'],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    executer: (args, f) => verifierSousDomaines(args.domaine, args.sous_domaines, f),
  },
  {
    name: 'infos_renouvellement',
    description: 'Date d\'enregistrement et d\'expiration d\'un domaine, jours restants, registrar et serveurs DNS, lus dans le registre officiel (RDAP). Alerte si moins de 60 jours. Lecture seule.',
    inputSchema: {
      type: 'object',
      properties: { domaine: { type: 'string', description: 'ex. agence-elite.fr' } },
      required: ['domaine'],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    executer: (args, f) => infosDomaine(args.domaine, f),
  },
];
