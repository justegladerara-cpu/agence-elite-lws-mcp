# Connecteur « Agence Elite — Domaines LWS » (MCP)

Connecteur pour Claude et ChatGPT qui lit l'état des domaines d'Agence Elite.
**Phase 1 : lecture seule, aucune clé LWS.** Il ne modifie rien.

## Outils

| Outil | Ce qu'il fait |
|---|---|
| `dns_lookup` | Lit un enregistrement DNS public (A, AAAA, CNAME, MX, TXT, NS, CAA, SOA). |
| `verifier_domaine` | Contrôle complet : serveurs DNS, site racine, e-mails (MX, SPF, DMARC), sous-domaines attendus (crm, saas → Cloudflare Pages), renouvellement. Chaque point : OK / ATTENTION / PROBLÈME. |
| `verifier_sous_domaines` | Pour chaque sous-domaine : existe ou non, et vers quoi il pointe. |
| `infos_renouvellement` | Dates d'enregistrement et d'expiration (registre officiel RDAP), jours restants, alerte sous 60 jours. |

Sources : DNS public via DNS-over-HTTPS (Cloudflare) et registre RDAP (AFNIC pour les .fr).
La configuration attendue est dans `ATTENDU` (`src/outils.js`).

## Mise en ligne (Cloudflare Workers, gratuit)

1. Cloudflare › Workers & Pages › Créer › Importer un dépôt › choisir `agence-elite-lws-mcp`.
   Pas de commande de build. Commande de déploiement : `npx wrangler deploy`.
2. L'adresse du connecteur est `https://agence-elite-lws-mcp.<compte>.workers.dev/mcp`.
3. Claude : Paramètres › Connecteurs › Ajouter un connecteur personnalisé › coller l'adresse `/mcp`.
4. ChatGPT : Paramètres › Applications et connecteurs › mode développeur › Créer › coller l'adresse `/mcp`, authentification « Aucune ».

## Tests

`npm test` (Node 20+) : tests hors ligne, réseau simulé.

## Phase 2 (pas encore faite)

API LWS (liste des domaines et services, facturation, modification DNS).
- La clé API LWS se range uniquement dans les secrets du serveur (`wrangler secret put LWS_API_KEY`), jamais dans Claude ou ChatGPT.
- LWS exige des adresses IP autorisées : il faut un hébergement à IP fixe (Workers n'en a pas).
- Le connecteur devra alors être protégé par une connexion (OAuth).
- Toute modification DNS demandera une confirmation explicite.
