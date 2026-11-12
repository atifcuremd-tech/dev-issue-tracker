// Run: node check/test.js   (no network needed, uses a local test server)
const http = require('http');
const assert = require('assert');
const C = require('./checks');

const pages = {
  '/good': `<html><head><title>Good page</title><meta content="About us" name="description"></head><body>
    <header><a href="/a">A</a><a href="#top">top</a><a href="mailto:x@y.com">m</a><a href="tel:1">t</a>
      <a href="javascript:void(0);">j</a><a href="https://other.example/x">ext</a></header>
    <main><a href="/moved">in body, not checked</a><p>Founded in 1997 &amp; still going</p></main>
    <div class="mt60 bg_footer"><a href="/b">B</a><a href="/a#x">A again</a></div></body></html>`,
  '/bad': `<html><body><header><a href="/a">A</a><a href="/moved">M</a><a href="/missing">X</a><a href="/login">L</a></header>
    <article><header><a href="/moved">article header, ignored</a></header><footer><a href="/moved">article footer, ignored</a></footer></article>
    <footer class="site"><a href="/moved">M</a></footer><p>We are 25 years old. Ã¢â‚¬â„¢</p></body></html>`,
  '/flaky-links': '<header><a href="/a">A</a><a href="/down">D</a></header>',
  '/a': 'ok', '/b': 'ok', '/c': 'ok',
};
function handler(req, res) {
  const p = req.url;
  if (p === '/moved') { res.writeHead(301, { location: '/a' }); return res.end(); }
  if (p === '/login') { res.writeHead(302, { location: '/c' }); return res.end(); }
  if (p === '/two-hops') { res.writeHead(301, { location: '/moved' }); return res.end(); }
  if (p === '/gone') { res.writeHead(410); return res.end(); }
  if (p === '/down') { res.writeHead(503); return res.end(); }
  if (!(p in pages)) { res.writeHead(404); return res.end('nope'); }
  res.writeHead(200, { 'content-type': 'text/html' }); res.end(pages[p]);
}

(async () => {
  const server = http.createServer(handler).listen(0);
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const f = C.makeFetcher({ pauseMs: 0 });

  // area finding
  assert.ok(C.findArea(pages['/good'], 'footer').includes('/b'), 'footer by class when no <footer> tag');
  assert.ok(!C.findArea(pages['/good'], 'footer').includes('/moved'), 'footer area excludes body');
  const badFooter = C.findArea(pages['/bad'], 'footer');
  assert.ok(badFooter.includes('class="site"') && !badFooter.includes('article footer'), 'page footer after last </article>');
  assert.ok(!C.findArea(pages['/bad'], 'header').includes('article header'), 'first header only');

  // link extraction: internal only, skips #, mailto, tel, javascript, dedupes ignoring #hash
  const links = C.extractLinks(C.findArea(pages['/good'], 'header') + C.findArea(pages['/good'], 'footer'), base + '/good');
  assert.deepStrictEqual(links, [base + '/a', base + '/b']);
  assert.ok(C.sameSite('https://curemd.com/x', 'https://www.curemd.com/'), 'www and non www are the same site');

  // links check
  let r = await C.runCheck('links', { areas: ['header', 'footer'] }, base + '/good', f);
  assert.strictEqual(r.result, 'pass', r.lines.join('\n'));
  r = await C.runCheck('links', { areas: ['header', 'footer'], exempt: [base + '/login/'] }, base + '/bad', f);
  assert.strictEqual(r.result, 'fail');
  assert.ok(r.lines.some(l => l.includes('/moved') && l.includes('301') && l.includes(base + '/a')), r.lines.join('\n'));
  assert.ok(r.lines.some(l => l.includes('/missing') && l.includes('404')));
  assert.ok(!r.lines.some(l => l.includes('/login')), 'exempt link ignored (trailing slash tolerant)');
  assert.strictEqual(r.lines.filter(l => l.includes('/moved')).length, 1, 'same link reported once');
  assert.strictEqual((await C.runCheck('links', { areas: ['header'] }, base + '/flaky-links', f)).result, 'error', 'a link with a server error is untested, not broken');

  // response check
  assert.strictEqual((await C.runCheck('response', { expect: '200' }, base + '/a', f)).result, 'pass');
  assert.strictEqual((await C.runCheck('response', { expect: 'redirect', target: base + '/a' }, base + '/moved', f)).result, 'pass');
  r = await C.runCheck('response', { expect: 'redirect', target: base + '/a' }, base + '/two-hops', f);
  assert.strictEqual(r.result, 'fail'); assert.ok(r.lines.join(' ').includes('/moved'), 'shows every hop');
  assert.strictEqual((await C.runCheck('response', { expect: 'gone' }, base + '/gone', f)).result, 'pass');
  assert.strictEqual((await C.runCheck('response', { expect: '200' }, base + '/down', f)).result, 'error', '5xx is error, not fail');

  // text check (visible text, entities decoded, case insensitive)
  assert.strictEqual((await C.runCheck('text', { text: 'founded in 1997 & still', mode: 'contains' }, base + '/good', f)).result, 'pass');
  assert.strictEqual((await C.runCheck('text', { text: '25 years', mode: 'absent' }, base + '/bad', f)).result, 'fail');
  assert.strictEqual((await C.runCheck('text', { text: 'Ã¢â‚¬', mode: 'absent' }, base + '/bad', f)).result, 'fail');
  assert.strictEqual((await C.runCheck('text', { text: 'moved', mode: 'absent' }, base + '/good', f)).result, 'pass', 'href text is not visible text');

  // meta check
  assert.strictEqual((await C.runCheck('meta', { field: 'title', expected: 'Good page', match: 'exact' }, base + '/good', f)).result, 'pass');
  assert.strictEqual((await C.runCheck('meta', { field: 'description', expected: 'about', match: 'contains' }, base + '/good', f)).result, 'pass');
  assert.strictEqual((await C.runCheck('meta', { field: 'title', expected: 'Other', match: 'exact' }, base + '/good', f)).result, 'fail');

  // page problems: missing page is a fail, server error or no connection is an error
  assert.strictEqual((await C.runCheck('text', { text: 'x', mode: 'absent' }, base + '/nothing', f)).result, 'fail');
  assert.strictEqual((await C.runCheck('links', { areas: ['page'] }, base + '/down', f)).result, 'error');
  assert.strictEqual((await C.runCheck('links', { areas: ['page'] }, 'http://127.0.0.1:1/', f)).result, 'error');

  // issue = all its pages: any fail -> fail; else any error -> error; else pass
  r = await C.runIssue({ check_type: 'links', check_config: { areas: ['header', 'footer'] }, pages: [base + '/good', base + '/bad'] }, f);
  assert.strictEqual(r.result, 'fail'); assert.ok(r.detail.includes(base + '/bad'));
  r = await C.runIssue({ check_type: 'response', check_config: { expect: '200' }, pages: [base + '/a', base + '/down'] }, f);
  assert.strictEqual(r.result, 'error');
  assert.strictEqual((await C.runIssue({ check_type: 'links', check_config: { areas: ['page'] }, pages: [] }, f)).result, 'error', 'no pages is an error');

  // retry: only failures are rerun, after one wait; the second result is final
  let waits = 0; const calls = {};
  const results = await C.withRetry([{ id: 1 }, { id: 2 }, { id: 3 }], async it => {
    calls[it.id] = (calls[it.id] || 0) + 1;
    if (it.id === 1) return { result: 'pass' };
    if (it.id === 2) return { result: calls[2] === 1 ? 'fail' : 'pass' };   // flaky, recovers
    return { result: 'fail' };                                               // really broken
  }, async () => { waits++; });
  assert.deepStrictEqual(results.map(x => x.outcome.result), ['pass', 'pass', 'fail']);
  assert.deepStrictEqual(calls, { 1: 1, 2: 2, 3: 2 }); assert.strictEqual(waits, 1);
  waits = 0; await C.withRetry([{ id: 1 }], async () => ({ result: 'pass' }), async () => { waits++; });
  assert.strictEqual(waits, 0, 'no wait when nothing failed');

  server.close();
  console.log('all checks passed');
})().catch(e => { console.error(e); process.exit(1); });
