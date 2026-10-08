// Tests hors ligne : le réseau est simulé (DNS-over-HTTPS et RDAP).
import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { traiter } from '../src/index.js';

const ZONE = {
  'agence-elite.fr|NS': [[2, 'ns17.lwsdns.com.'], [2, 'ns18.lwsdns.com.']],
  'agence-elite.fr|A': [[1, '213.255.195.10']],
  'agence-elite.fr|MX': [[15, '10 mail.agence-elite.fr.']],
  'agence-elite.fr|TXT': [[16, '"v=spf1 include:_spf.lws.fr ~all"']],
  'crm.agence-elite.fr|CNAME': [[5, 'agence-elite-crm.pages.dev.']],
  'saas.agence-elite.fr|CNAME': [[5, 'autre.example.com.']],
};

function faux(url) {
  const u = new URL(url);
  if (u.hostname === 'rdap.nic.fr') {
    if (!u.pathname.endsWith('agence-elite.fr')) return new Response('', { status: 404 });
    return Response.json({
      status: ['active'],
      events: [
        { eventAction: 'registration', eventDate: '2026-09-14T20:21:13Z' },
        { eventAction: 'expiration', eventDate: '2027-09-14T20:21:13Z' },
      ],
      entities: [{ roles: ['registrar'], vcardArray: ['vcard', [['fn', {}, 'text', 'SAS Ligne Web Services - LWS']]] }],
      nameservers: [{ ldhName: 'ns17.lwsdns.com' }, { ldhName: 'ns18.lwsdns.com' }],
    });
  }
  const nom = u.searchParams.get('name');
  const type = u.searchParams.get('type');
  const rr = ZONE[`${nom}|${type}`];
  const existe = Object.keys(ZONE).some((k) => k.startsWith(`${nom}|`)) || nom.endsWith('agence-elite.fr');
  return Response.json({
    Status: existe ? 0 : 3,
    Answer: rr?.map(([t, data]) => ({ name: `${nom}.`, type: t, TTL: 300, data })),
  });
}
const f = async (url) => faux(url);
const appel = (name, args) => traiter({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, f);

test('initialize et tools/list', async () => {
  const init = await traiter({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
  assert.equal(init.result.protocolVersion, '2025-03-26');
  assert.equal(init.result.serverInfo.name, 'agence-elite-lws');
  const liste = await traiter({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual(liste.result.tools.map((o) => o.name), ['dns_lookup', 'verifier_domaine', 'verifier_sous_domaines', 'infos_renouvellement']);
  assert.ok(liste.result.tools.every((o) => o.annotations.readOnlyHint && !('executer' in o)));
});

test('notification sans réponse, méthode inconnue', async () => {
  assert.equal(await traiter({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.equal((await traiter({ jsonrpc: '2.0', id: 3, method: 'x' })).error.code, -32601);
});

test('dns_lookup', async () => {
  const r = (await appel('dns_lookup', { nom: 'crm.agence-elite.fr.', type: 'cname' })).result.structuredContent;
  assert.equal(r.statut, 'OK');
  assert.equal(r.enregistrements[0].type, 'CNAME');
  assert.equal(r.enregistrements[0].valeur, 'agence-elite-crm.pages.dev.');
});

test('nom invalide renvoie une erreur lisible', async () => {
  const r = (await appel('dns_lookup', { nom: 'pas un domaine' })).result;
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /invalide/);
});

test('infos_renouvellement', async () => {
  const r = (await appel('infos_renouvellement', { domaine: 'agence-elite.fr' })).result.structuredContent;
  assert.equal(r.expire_le, '2027-09-14T20:21:13Z');
  assert.equal(r.registrar, 'SAS Ligne Web Services - LWS');
  assert.equal(typeof r.jours_restants, 'number');
});

test('verifier_domaine', async () => {
  const { controles } = (await appel('verifier_domaine', { domaine: 'agence-elite.fr' })).result.structuredContent;
  const etat = Object.fromEntries(controles.map((c) => [c.sujet, c.etat]));
  assert.equal(etat['Serveurs DNS'], 'OK');
  assert.equal(etat['E-mails (MX)'], 'OK');
  assert.equal(etat.SPF, 'OK');
  assert.equal(etat.DMARC, 'ATTENTION');
  assert.equal(etat['crm.agence-elite.fr'], 'OK');
  assert.equal(etat['saas.agence-elite.fr'], 'ATTENTION');
  assert.ok(etat.Renouvellement);
});

test('verifier_sous_domaines', async () => {
  const r = (await appel('verifier_sous_domaines', { domaine: 'agence-elite.fr', sous_domaines: ['crm', 'www'] })).result.structuredContent;
  assert.equal(r.sous_domaines[0].cname, 'agence-elite-crm.pages.dev');
  assert.equal(r.sous_domaines[1].existe, false);
});

test('Worker HTTP : routes', async () => {
  const racine = await worker.fetch(new Request('https://x.dev/'));
  assert.equal((await racine.json()).mode, 'lecture seule');
  assert.equal((await worker.fetch(new Request('https://x.dev/mcp'))).status, 405);
  const notif = await worker.fetch(new Request('https://x.dev/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) }));
  assert.equal(notif.status, 202);
  const ping = await worker.fetch(new Request('https://x.dev/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'ping' }) }));
  assert.deepEqual((await ping.json()).result, {});
  assert.equal((await worker.fetch(new Request('https://x.dev/mcp', { method: 'POST', body: '{' }))).status, 400);
});
