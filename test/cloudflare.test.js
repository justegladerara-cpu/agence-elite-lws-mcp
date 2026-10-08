// Adresses clients via une fausse API Cloudflare.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { traiter } from '../src/index.js';

const ENV = { CF_API_TOKEN: 'tok', MCP_JETON: 'k'.repeat(30) };

function fauxCf({ wildcard = true } = {}) {
  const domaines = [{ name: 'saas.agence-elite.fr', status: 'active', validation_data: { status: 'active' } }];
  const f = async (url, init = {}) => {
    const u = new URL(url);
    if (u.hostname === 'cloudflare-dns.com') {
      const nom = u.searchParams.get('name');
      const Answer = wildcard && nom.endsWith('.agence-elite.fr') ? [{ name: `${nom}.`, type: 5, TTL: 300, data: 'agence-elite-saas.pages.dev.' }] : [];
      return Response.json({ Status: 0, Answer });
    }
    if (u.pathname === '/client/v4/accounts') return Response.json({ success: true, result: [{ id: 'acc' }] });
    assert.equal(u.pathname, '/client/v4/accounts/acc/pages/projects/agence-elite-saas/domains');
    assert.equal(init.headers.authorization, 'Bearer tok');
    if (init.method === 'POST') {
      const { name } = JSON.parse(init.body);
      const d = { name, status: 'pending', validation_data: { status: 'pending' } };
      domaines.push(d);
      return Response.json({ success: true, result: d });
    }
    return Response.json({ success: true, result: domaines });
  };
  return { f, domaines };
}
const appel = (f, name, args) => traiter({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, f, ENV);

test('outils présents seulement avec la clé Cloudflare', async () => {
  const noms = (await traiter({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, fetch, ENV)).result.tools.map((o) => o.name);
  assert.ok(noms.includes('creer_sous_domaine_client') && !noms.includes('lws_zone_dns'));
});

test('création de thedream.agence-elite.fr', async () => {
  const { f, domaines } = fauxCf();
  assert.equal((await appel(f, 'creer_sous_domaine_client', { sous_domaine: 'thedream' })).result.isError, true);
  const r = (await appel(f, 'creer_sous_domaine_client', { sous_domaine: 'TheDream.agence-elite.fr', confirmation: 'OUI' })).result.structuredContent;
  assert.equal(r.adresse, 'https://thedream.agence-elite.fr');
  assert.equal(r.dns, 'OK');
  assert.equal(domaines.length, 2);
  const encore = (await appel(f, 'creer_sous_domaine_client', { sous_domaine: 'thedream', confirmation: 'OUI' })).result.structuredContent;
  assert.equal(encore.deja_existant, true);
  assert.equal(domaines.length, 2);
  const liste = (await appel(f, 'lister_sous_domaines_clients', {})).result.structuredContent;
  assert.equal(liste.adresses.length, 2);
});

test('noms refusés et DNS manquant signalé', async () => {
  const { f } = fauxCf({ wildcard: false });
  for (const s of ['crm', 'mail', 'a b', '-x', 'x.y'])
    assert.equal((await appel(f, 'creer_sous_domaine_client', { sous_domaine: s, confirmation: 'OUI' })).result.isError, true, s);
  const r = (await appel(f, 'creer_sous_domaine_client', { sous_domaine: 'client1', confirmation: 'OUI' })).result.structuredContent;
  assert.match(r.dns, /CNAME « \* »/);
});

test('adresse protégée par jeton avec la clé Cloudflare', async () => {
  const corps = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' });
  assert.equal((await worker.fetch(new Request('https://x.fr/mcp', { method: 'POST', body: corps }), ENV)).status, 404);
  assert.equal((await worker.fetch(new Request(`https://x.fr/mcp/${'k'.repeat(30)}`, { method: 'POST', body: corps }), ENV)).status, 200);
});
