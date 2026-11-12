// Weekly check: runs every tracked issue's check against the live site and records the results.
// Run by GitHub Actions (see .github/workflows/weekly-check.yml). Needs two secrets:
//   SUPABASE_URL          e.g. https://abcd.supabase.co
//   SUPABASE_SERVICE_KEY  the service_role (secret) key from Supabase. Never put it in index.html.
const fs = require('fs');
const C = require('./checks');

const URL_ = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const KEY = process.env.SUPABASE_SERVICE_KEY;
const RETRY_MINUTES = +(process.env.RETRY_MINUTES || 3);
if (!URL_ || !KEY) { console.error('Set SUPABASE_URL and SUPABASE_SERVICE_KEY.'); process.exit(1); }

async function api(path, body) {
  const res = await fetch(`${URL_}/rest/v1/${path}`, {
    method: body ? 'POST' : 'GET',
    // New style keys (sb_secret_...) go in the apikey header only; old style keys (eyJ...) also need the Bearer header.
    headers: { apikey: KEY, ...(KEY.startsWith('eyJ') ? { authorization: `Bearer ${KEY}` } : {}), 'content-type': 'application/json' },
    body: body && JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

(async () => {
  const started = new Date().toISOString();
  const issues = await api('issues?select=id,title,pages,status,check_type,check_config&status=neq.Closed&check_type=neq.manual&order=id');
  console.log(`Checking ${issues.length} issues`);
  const fetchFn = C.makeFetcher();
  const results = await C.withRetry(issues, it => C.runIssue(it, fetchFn), async () => {
    console.log(`Some checks failed. Waiting ${RETRY_MINUTES} minutes and trying those again before reopening anything.`);
    await new Promise(r => setTimeout(r, RETRY_MINUTES * 60000));
  });

  const n = { passed: 0, failed: 0, errors: 0, reopened: 0 };
  for (const { item, outcome } of results) {
    n[{ pass: 'passed', fail: 'failed', error: 'errors' }[outcome.result]]++;
    if (await api('rpc/record_check', { p_id: item.id, p_result: outcome.result, p_detail: outcome.detail.slice(0, 20000) })) n.reopened++;
    console.log(`#${item.id}: ${outcome.result.toUpperCase()}`);   // the repo is public, so logs carry no titles or details; those are in the app
  }
  await api('rpc/record_run', { p_started: started, p_checked: issues.length, p_passed: n.passed, p_failed: n.failed, p_errors: n.errors, p_reopened: n.reopened });
  const summary = `${new Date().toISOString()} checked ${issues.length}: ${n.passed} passed, ${n.failed} failed, ${n.errors} could not be checked, ${n.reopened} reopened`;
  console.log(summary);
  fs.writeFileSync('last-run.txt', summary + '\n');   // committed by the workflow so GitHub keeps the schedule on
  if (issues.length && n.errors === issues.length) console.log('Every check errored: the site may be down or blocking GitHub. Nothing was reopened.');
})().catch(e => { console.error(e); process.exit(1); });
