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

## Phase 2 : compte LWS (avec la clé)

Outils ajoutés quand `LWS_LOGIN` et `LWS_CLE` sont dans les secrets du serveur :

| Outil | Ce qu'il fait |
|---|---|
| `lws_zone_dns` | Zone DNS complète du domaine dans LWS (avec l'id de chaque ligne). |
| `lws_infos_domaine` | Infos LWS du domaine (état, expiration, renouvellement auto). |
| `lws_lecture` | Lecture libre (GET) dans l'API LWS : hébergements, compte, solde, factures. |
| `lws_dns_preparer` | Prépare un ajout, une modification ou une suppression : plan avant → après, **rien n'est changé**. |
| `lws_dns_appliquer` | Applique le plan, seulement avec confirmation « OUI » après l'accord de Juste. |

Sécurités :
- La clé reste dans les secrets du serveur (`deploiement/.env`), jamais dans Git, Claude ou ChatGPT.
- Le plan est signé (HMAC) et valable 15 minutes ; un plan modifié ou une zone qui a changé entre-temps est refusé.
- Si la nouvelle valeur est refusée par LWS lors d'une modification, l'ancienne ligne est remise.
- Seuls les domaines de `LWS_DOMAINES_MODIFIABLES` (défaut `agence-elite.fr`) sont modifiables.
- L'adresse devient `/mcp/<MCP_JETON>` : elle sert de mot de passe, ne la partage pas.

API utilisée : `https://api.lws.net/v1`, en-têtes `X-Auth-Login` / `X-Auth-Pass`,
zone DNS `GET/POST/DELETE /domain/{domaine}/zdns` (repris de la bibliothèque libdns-lws, la doc officielle n'étant pas lisible par les IA).

### Serveur à IP fixe (LWS l'exige)

1. Créer un serveur Ubuntu gratuit (Oracle Cloud « Always Free », IP publique réservée gratuite ; ouvrir les ports 80 et 443 dans la « Security List ») ou un petit VPS, et noter son IP.
2. Dans LWS, DNS de agence-elite.fr : ajouter `lws` en type A vers cette IP.
3. Dans panel.lws.fr › Api LWS : autoriser cette IP, copier l'identifiant et la clé.
4. Sur le VPS : `curl -fsSL https://raw.githubusercontent.com/justegladerara-cpu/agence-elite-lws-mcp/main/deploiement/installer.sh | sh`,
   remplir `LWS_LOGIN` et `LWS_CLE` dans `/opt/connecteur/deploiement/.env`, relancer la même commande.
5. Le script affiche l'adresse `https://lws.agence-elite.fr/mcp/<jeton>` à mettre dans Claude et ChatGPT.
