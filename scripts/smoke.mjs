// End-to-end check against a running gateway (local `wrangler dev` or deployed).
// Usage: node scripts/smoke.mjs [baseUrl] [agentToken] [adminToken]
// Default tokens match the local .dev.vars in the README. Content checks assume the sample vault (TEST-QUESTIONS.md answers);
// set VAULT=real to skip them on your own vault. Writes only inbox/agents/smoke-test.md, overwritten each run.
const base = process.argv[2] ?? 'http://127.0.0.1:8787';
const token = process.argv[3] ?? 'local-dev-token-claude-0123456789';
const admin = process.argv[4] ?? 'local-dev-admin-token-0123456789';
const sample = process.env.VAULT !== 'real';

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) pass++;
  else fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ->  ' + detail}`);
};

let id = 0;
async function rpc(method, params, url = `${base}/mcp`, headers = { authorization: `Bearer ${token}` }) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
  });
  return { status: res.status, body: res.status === 202 ? null : await res.json() };
}
const tool = async (name, args) => {
  const r = await rpc('tools/call', { name, arguments: args });
  return { isError: !!r.body.result?.isError, text: r.body.result?.content?.[0]?.text ?? '' };
};

// --- plumbing and auth
ok('health is open', (await fetch(`${base}/health`)).status === 200);
ok('no token is rejected', (await fetch(`${base}/mcp`, { method: 'POST', body: '{}' })).status === 401);
ok('wrong token is rejected', (await fetch(`${base}/mcp`, { method: 'POST', headers: { authorization: 'Bearer wrong-wrong-wrong-wrong' }, body: '{}' })).status === 401);
const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } });
ok('initialize', init.body.result?.serverInfo?.name === 'memory-gateway', JSON.stringify(init.body));
const tl = await rpc('tools/list');
ok('five tools listed', tl.body.result?.tools?.length === 5);
ok('URL-token auth works', (await rpc('tools/list', undefined, `${base}/t/${token}/mcp`, {})).status === 200);

// --- index the vault
const re = await fetch(`${base}/admin/reindex`, { method: 'POST', headers: { authorization: `Bearer ${admin}` } });
const reJson = await re.json();
ok('admin reindex', re.status === 200 && reJson.total > 0 && reJson.remaining === 0, JSON.stringify(reJson));
console.log('      reindex:', JSON.stringify(reJson));
ok('admin needs admin token', (await fetch(`${base}/admin/reindex`, { method: 'POST', headers: { authorization: `Bearer ${token}` } })).status === 401);

// --- read
const start = await tool('read_note', { path: 'core/START-HERE.md' });
ok('read START-HERE', !start.isError && start.text.length > 0 && (!sample || start.text.includes('Alex Rivera')), start.text.slice(0, 120));
ok('read missing note errors cleanly', (await tool('read_note', { path: 'nope/missing.md' })).isError);
ok('path traversal blocked', (await tool('read_note', { path: '../etc/passwd' })).isError);

// --- list
const top = await tool('list', {});
ok('list top level', top.text.includes('core/') && top.text.includes('inbox/'), top.text.slice(0, 200));

// --- sample-vault content: the 12 test questions must find their source note in the top results
if (sample) {
  const infra = await tool('list', { folder: 'infra' });
  ok('list infra', infra.text.includes('infra/vlans.md'), infra.text.slice(0, 200));
  const questions = [
    ['What is the IP address of the NAS?', 'infra/nas-synology.md', '10.10.30.50'],
    ['Which VLAN do the cameras use and can they reach the internet', 'infra/vlans.md'],
    ['When was NAS disk 3 replaced', 'infra/incident-2026-09-nas-disk.md'],
    ['old network address range retired', 'infra/old-network.md'],
    ['When is the Tidewalker alpha due', 'projects/tidewalker-game.md'],
    ['Who makes the music for the game', 'people/miguel-costa.md'],
    ['weekly review time', 'routines/weekly-review.md'],
    ['Which port does WireGuard use', 'infra/vpn-wireguard.md'],
    ['how should answers be formatted units', 'core/preferences.md'],
    ['why choose R2 instead of OneDrive for sync', 'decisions/2026-08-use-r2-for-sync.md'],
    ['where does an agent write a new note', 'core/START-HERE.md'],
    ['second AdGuard proposal', 'inbox/agents/2026-11-02-dns-redundancy-proposal.md'],
  ];
  for (const [q, expected, mustContain] of questions) {
    const r = await tool('search', { query: q, limit: 5 });
    const hit = r.text.includes(expected);
    ok(`search: ${q}`, hit && (!mustContain || r.text.includes(mustContain)), r.text.split('\n').slice(0, 6).join(' | '));
  }
  const oldNet = await tool('search', { query: 'old network address range retired', limit: 5 });
  ok('outdated note is flagged', /old-network\.md[^\n]*\[outdated\]/.test(oldNet.text), oldNet.text.slice(0, 300));
  const scoped = await tool('search', { query: 'dns', folder: 'infra', limit: 10 });
  ok('folder-scoped search stays in folder', scoped.text.includes('infra/') && !/\n\d+\. (people|projects)\//.test(scoped.text), scoped.text.slice(0, 300));
} else console.log('      VAULT=real: sample-content checks skipped');
ok('empty search result is graceful', (await tool('search', { query: 'zzzzqqqqxxxx' })).text.startsWith('No notes matched'));
ok('FTS syntax in query cannot break search', !(await tool('search', { query: 'foo" OR NEAR( * )' })).isError);

// --- write guardrails
const bad = await tool('write_note', { path: 'core/hack.md', content: '# nope' });
ok('write outside inbox refused', bad.isError && bad.text.includes('inbox/agents/'), bad.text);
// Fixed path so repeated runs leave one note behind; a per-run token proves the search hit is fresh.
const name = 'inbox/agents/smoke-test.md';
const marker = `pelicanwhisper${Date.now()}`;
const w = await tool('write_note', { path: name, content: `---\nstatus: current\n---\n# Smoke test note\nUnique token ${marker}.`, overwrite: true });
ok('write to inbox', !w.isError, w.text);
const back = await tool('read_note', { path: name });
ok('written note is a draft stamped with the agent', back.text.includes('status: draft') && back.text.includes('written_by: claude') && !back.text.includes('status: current'), back.text);
const found = await tool('search', { query: marker });
ok('written note is searchable immediately', found.text.includes(name), found.text);
ok('second write without overwrite refused', (await tool('write_note', { path: name, content: '# again' })).isError);
ok('overwrite allowed when asked', !(await tool('write_note', { path: name, content: `# Smoke test note\nUnique token ${marker}.`, overwrite: true })).isError);

// --- edit_note: core/ is always refused; other edits need EDIT_POLICY and a BACKUP bucket (EXPECT_EDIT=1)
ok('edit of core/ refused', (await tool('edit_note', { path: 'core/START-HERE.md', old_text: 'a', new_text: 'b' })).isError);
const ed = await tool('edit_note', { path: name, old_text: `Unique token ${marker}.`, new_text: `Edited token ${marker}.` });
if (process.env.EXPECT_EDIT === '1') {
  ok('edit_note edits an allowed note', !ed.isError && (await tool('read_note', { path: name })).text.includes(`Edited token ${marker}.`), ed.text);
} else {
  ok('edit_note refused without policy/backup', ed.isError, ed.text);
}

// --- REST binding
const h = { authorization: `Bearer ${token}` };
const rs = await (await fetch(`${base}/api/search?q=${encodeURIComponent(marker)}`, { headers: h })).json();
ok('REST search', rs.results?.some((x) => x.path === name), JSON.stringify(rs).slice(0, 200));
const rr = await fetch(`${base}/api/notes/core/START-HERE.md`, { headers: h });
ok('REST read', rr.status === 200 && (await rr.text()).length > 0);
const rp = await fetch(`${base}/api/notes/core/x.md`, { method: 'PUT', headers: h, body: '# x' });
ok('REST write outside inbox is 403', rp.status === 403);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
