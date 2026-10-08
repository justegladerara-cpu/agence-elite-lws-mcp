// Outils LWS avec une fausse API LWS en mémoire.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { traiter } from '../src/index.js';

const ENV = { LWS_LOGIN: 'LWS-1', LWS_CLE: 'cle-secrete', MCP_JETON: 'j'.repeat(32) };

function fausseLws() {
  let prochainId = 3;
  const zone = [
    { id: 1, type: 'CNAME', name: 'crm', value: 'agence-elite-crm.pages.dev', ttl: 3600 },
    { id: 2, type: 'A', name: '@', value: '1.2.3.4', ttl: 3600 },
  ];
  const appels = [];
  const f = async (url, init = {}) => {
    const u = new URL(url);
    appels.push(`${init.method} ${u.pathname}`);
    assert.equal(init.headers['X-Auth-Pass'], 'cle-secrete');
    const corps = init.body ? JSON.parse(init.body) : null;
    const ok = (data) => Response.json({ code: 200, info: 'ok', data });
    if (u.pathname === '/v1/domain/agence-elite.fr/zdns') {
      if (init.method === 'GET') return ok(structuredClone(zone));
      if (init.method === 'POST') {
        if (corps.value === 'refuse.example') return Response.json({ code: 400, info: 'valeur refusée' });
        const l = { id: prochainId++, ...corps };
        zone.push(l);
        return ok(l);
      }
      if (init.method === 'DELETE') {
        zone.splice(zone.findIndex((l) => l.id === corps.id), 1);
        return ok(null);
      }
    }
    if (u.pathname === '/v1/domain/agence-elite.fr') return ok({ domain: 'agence-elite.fr', autorenew: true });
    return Response.json({ code: 401, info: 'IP non autorisée' }, { status: 401 });
  };
  return { f, zone, appels };
}
const appel = (f, name, args) => traiter({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, f, ENV);

test('outils LWS absents sans clé, présents avec', async () => {
  const sans = await traiter({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, fetch, {});
  assert.equal(sans.result.tools.length, 4);
  const avec = await traiter({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, fetch, ENV);
  assert.equal(avec.result.tools.length, 9);
  assert.equal(avec.result.tools.find((o) => o.name === 'lws_dns_appliquer').annotations.destructiveHint, true);
});

test('lecture de la zone et des infos', async () => {
  const { f } = fausseLws();
  const z = (await appel(f, 'lws_zone_dns', { domaine: 'agence-elite.fr' })).result.structuredContent;
  assert.equal(z.lignes.length, 2);
  const i = (await appel(f, 'lws_lecture', { chemin: '/domain/agence-elite.fr' })).result.structuredContent;
  assert.equal(i.autorenew, true);
  assert.equal((await appel(f, 'lws_lecture', { chemin: '/../x' })).result.isError, true);
  const refus = (await appel(f, 'lws_lecture', { chemin: '/account' })).result;
  assert.match(refus.content[0].text, /IP du serveur/);
});

test('préparer ne modifie rien ; appliquer exige OUI et un plan intact', async () => {
  const { f, zone, appels } = fausseLws();
  const plan = (await appel(f, 'lws_dns_preparer', { domaine: 'agence-elite.fr', action: 'modifier', id: 1, type: 'CNAME', nom: 'crm', valeur: 'nouveau.pages.dev' })).result.structuredContent;
  assert.equal(plan.avant.value, 'agence-elite-crm.pages.dev');
  assert.equal(plan.apres.value, 'nouveau.pages.dev');
  assert.ok(appels.every((a) => a.startsWith('GET')));

  assert.equal((await appel(f, 'lws_dns_appliquer', { plan, confirmation: 'non' })).result.isError, true);
  const truque = { ...plan, apres: { ...plan.apres, value: 'pirate.example' } };
  assert.match((await appel(f, 'lws_dns_appliquer', { plan: truque, confirmation: 'OUI' })).result.content[0].text, /Plan modifié/);
  assert.equal(zone.find((l) => l.name === 'crm').value, 'agence-elite-crm.pages.dev');

  const fait = (await appel(f, 'lws_dns_appliquer', { plan, confirmation: 'OUI' })).result.structuredContent;
  assert.equal(fait.action, 'modifié');
  assert.equal(zone.find((l) => l.name === 'crm').value, 'nouveau.pages.dev');
  assert.match((await appel(f, 'lws_dns_appliquer', { plan, confirmation: 'OUI' })).result.content[0].text, /zone a changé/);
});

test('échec de la nouvelle valeur : ancienne ligne remise', async () => {
  const { f, zone } = fausseLws();
  const plan = (await appel(f, 'lws_dns_preparer', { domaine: 'agence-elite.fr', action: 'modifier', id: 2, type: 'A', nom: '@', valeur: 'refuse.example' })).result.structuredContent;
  const r = (await appel(f, 'lws_dns_appliquer', { plan, confirmation: 'OUI' })).result;
  assert.match(r.content[0].text, /remise en place/);
  assert.equal(zone.find((l) => l.name === '@').value, '1.2.3.4');
});

test('ajout, suppression et domaine non autorisé', async () => {
  const { f, zone } = fausseLws();
  const ajout = (await appel(f, 'lws_dns_preparer', { domaine: 'agence-elite.fr', action: 'ajouter', type: 'TXT', nom: '_dmarc', valeur: 'v=DMARC1; p=none', ttl: 1000 })).result.structuredContent;
  assert.equal(ajout.apres.ttl, 900);
  await appel(f, 'lws_dns_appliquer', { plan: ajout, confirmation: 'OUI' });
  assert.ok(zone.some((l) => l.name === '_dmarc'));
  const supp = (await appel(f, 'lws_dns_preparer', { domaine: 'agence-elite.fr', action: 'supprimer', id: 1 })).result.structuredContent;
  await appel(f, 'lws_dns_appliquer', { plan: supp, confirmation: 'OUI' });
  assert.ok(!zone.some((l) => l.id === 1));
  assert.match((await appel(f, 'lws_dns_preparer', { domaine: 'gladerara.fr', action: 'supprimer', id: 1 })).result.content[0].text, /interdite/);
});

test('adresse protégée par le jeton quand la clé est configurée', async () => {
  const corps = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' });
  assert.equal((await worker.fetch(new Request('https://x.fr/mcp', { method: 'POST', body: corps }), ENV)).status, 404);
  assert.equal((await worker.fetch(new Request(`https://x.fr/mcp/${'j'.repeat(32)}`, { method: 'POST', body: corps }), ENV)).status, 200);
  assert.equal((await worker.fetch(new Request('https://x.fr/mcp', { method: 'POST', body: corps }), { ...ENV, MCP_JETON: 'court' })).status, 500);
});
