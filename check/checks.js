// Check logic for the Dev Issue Tracker. No dependencies (Node 22+ built in fetch).
// A check returns { result: 'pass' | 'fail' | 'error', lines: [...] }.
// 'error' means we could not test (site down, server error, timeout); it never reopens an issue.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// fetcher(url, { follow }) -> { status, location, url, body }. Throws on network error or timeout.
function makeFetcher({ pauseMs = 300, timeoutMs = 20000 } = {}) {
  return async (url, { follow = false } = {}) => {
    if (pauseMs) await sleep(pauseMs);   // be gentle with the site
    const res = await fetch(url, { redirect: follow ? 'follow' : 'manual', headers: { 'user-agent': UA }, signal: AbortSignal.timeout(timeoutMs) });
    const loc = res.headers.get('location');
    const body = follow ? await res.text() : (await res.body?.cancel(), '');
    return { status: res.status, location: loc ? new URL(loc, url).href : null, url: res.url || url, body };
  };
}

// The whole element that starts at index i (tag nesting counted), or the rest of the page if it never closes.
function elementAt(html, i) {
  const tag = /^<([a-z0-9]+)/i.exec(html.slice(i))[1];
  const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi');
  re.lastIndex = i; let depth = 0, m;
  while ((m = re.exec(html))) { depth += m[1] ? -1 : 1; if (depth === 0) return html.slice(i, re.lastIndex); }
  return html.slice(i);
}

// First element after `from` whose class has a token containing `word` (skipping modal parts), or -1.
function classIndex(html, word, from) {
  const re = /<[a-z0-9]+\b[^>]*\bclass\s*=\s*["']([^"']*)["']/gi; re.lastIndex = from; let m;
  while ((m = re.exec(html))) if (m[1].split(/\s+/).some(t => t.toLowerCase().includes(word) && !/^modal/i.test(t))) return m.index;
  return -1;
}

// 'page' = everything. 'header' = the first <header> element, else the first element with "header" in its class.
// 'footer' = the first <footer> after the last </article>, else the first element with "footer" in its class there;
// ponytail: footer runs to the end of the page (sites put nothing but chrome after it); tighten if that causes noise.
function findArea(html, which) {
  if (which === 'page') return html;
  const low = html.toLowerCase();
  if (which === 'header') {
    let i = low.search(/<header[\s>]/);
    if (i < 0) i = classIndex(html, 'header', 0);
    return i < 0 ? '' : elementAt(html, i);
  }
  const from = Math.max(0, low.lastIndexOf('</article>'));
  const rel = low.slice(from).search(/<footer[\s>]/);
  const i = rel >= 0 ? from + rel : classIndex(html, 'footer', from);
  return i < 0 ? '' : html.slice(i);
}

const bare = h => h.toLowerCase().replace(/^www\./, '');
const sameSite = (a, b) => bare(new URL(a).hostname) === bare(new URL(b).hostname);
const norm = u => { const x = new URL(u); x.hash = ''; return x.href; };
const noSlash = u => norm(u).replace(/\/$/, '');

// Internal links in a piece of HTML, absolute, deduplicated, in page order.
function extractLinks(html, pageUrl) {
  const out = [];
  for (const m of html.matchAll(/<a\b[^>]*?\bhref\s*=\s*(["'])(.*?)\1/gis)) {
    const href = decode(m[2]).trim();
    if (!href || href.startsWith('#') || /^(mailto|tel|javascript|sms|data):/i.test(href)) continue;
    let u; try { u = norm(new URL(href, pageUrl).href); } catch { continue; }
    if (/^https?:/.test(u) && sameSite(u, pageUrl) && !out.includes(u)) out.push(u);
  }
  return out;
}

function decode(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp|#39);/gi, (_, e) => {
    e = e.toLowerCase();
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : +e.slice(1));
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }[e];
  });
}
const visibleText = html => decode(html.replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ');

function metaValue(html, field) {
  if (field === 'title') { const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html); return m ? decode(m[1]).trim() : null; }
  for (const [tag] of html.matchAll(/<meta\b[^>]*>/gi)) {
    if (!/\bname\s*=\s*["']description["']/i.test(tag)) continue;
    const c = /\bcontent\s*=\s*(["'])([\s\S]*?)\1/i.exec(tag); return c ? decode(c[2]).trim() : '';
  }
  return null;
}

const err = line => ({ result: 'error', lines: [line] });
const isDown = s => s >= 500 || s === 429;

// Load a page for checking. Returns { page } or { outcome } when the page itself is the problem.
async function loadPage(url, fetchFn) {
  let p; try { p = await fetchFn(url, { follow: true }); } catch (e) { return { outcome: err(`Could not load ${url} (${e.cause?.code || e.name})`) }; }
  if (isDown(p.status)) return { outcome: err(`${url} answered ${p.status} (server problem, not tested)`) };
  if (p.status !== 200) return { outcome: { result: 'fail', lines: [`${url} answered ${p.status}`] } };
  return { page: p };
}

// Follow redirects one hop at a time, so every hop can be shown.
async function hops(url, fetchFn, max = 10) {
  const chain = [];
  for (let u = url; chain.length < max;) {
    const r = await fetchFn(u); chain.push({ url: u, status: r.status, location: r.location });
    if (!(r.status >= 300 && r.status < 400 && r.location)) break;
    u = r.location;
  }
  return chain;
}
const showChain = c => c.map(h => `${h.url} (${h.status})`).join(' then ');

async function runCheck(type, cfg, pageUrl, fetchFn) {
  if (type === 'response') {
    let chain; try { chain = await hops(pageUrl, fetchFn); } catch (e) { return err(`Could not load ${pageUrl} (${e.cause?.code || e.name})`); }
    const first = chain[0], last = chain[chain.length - 1];
    if (isDown(last.status)) return err(`${showChain(chain)}: server problem, not tested`);
    let ok;
    if (cfg.expect === '200') ok = first.status === 200;
    else if (cfg.expect === 'gone') ok = first.status === 404 || first.status === 410;
    else ok = first.status >= 300 && first.status < 400 && chain.length === 2 && last.status === 200 && noSlash(first.location) === noSlash(cfg.target);
    const want = { '200': 'answer 200', gone: 'answer 404 or 410', redirect: `redirect in one hop to ${cfg.target}` }[cfg.expect];
    return { result: ok ? 'pass' : 'fail', lines: [`Expected ${pageUrl} to ${want}. Got: ${showChain(chain)}`] };
  }

  const { page, outcome } = await loadPage(pageUrl, fetchFn);
  if (outcome) return outcome;

  if (type === 'links') {
    const areas = cfg.areas?.length ? cfg.areas : ['page'];
    const html = areas.map(a => findArea(page.body, a)).join('\n');
    const exempt = (cfg.exempt || []).filter(Boolean).map(u => { try { return noSlash(new URL(u, pageUrl).href); } catch { return u; } });
    const links = extractLinks(html, page.url).filter(u => !exempt.includes(noSlash(u)));
    if (!links.length) return { result: 'fail', lines: [`No internal links found in ${areas.join(' and ')} of ${pageUrl}. The page layout may have changed.`] };
    const bad = [], untested = [];
    for (const u of links) {
      let r; try { r = await fetchFn(u); } catch (e) { untested.push(`${u} could not be loaded (${e.cause?.code || e.name})`); continue; }
      if (r.status === 200) continue;
      if (isDown(r.status)) untested.push(`${u} answered ${r.status} (server problem, not tested)`);
      else bad.push(r.status >= 300 && r.status < 400 ? `${u} redirects (${r.status}) to ${r.location}` : `${u} answered ${r.status}`);
    }
    const where = `links in ${areas.join(' and ')} on ${pageUrl}`;
    if (bad.length) return { result: 'fail', lines: [`${bad.length} of ${links.length} ${where}:`, ...bad, ...untested] };
    if (untested.length) return { result: 'error', lines: [`${untested.length} of ${links.length} ${where} could not be tested:`, ...untested] };
    return { result: 'pass', lines: [`All ${links.length} ${where} answer 200`] };
  }

  if (type === 'text') {
    const text = visibleText(page.body), needle = (cfg.text || '').trim();
    const found = needle !== '' && text.toLowerCase().includes(needle.toLowerCase());
    const ok = cfg.mode === 'absent' ? !found : found;
    let line = `"${needle}" ${found ? 'found' : 'not found'} on ${pageUrl}`;
    if (found) { const i = text.toLowerCase().indexOf(needle.toLowerCase()); line += `: "...${text.slice(Math.max(0, i - 60), i + needle.length + 60).trim()}..."`; }
    return { result: ok ? 'pass' : 'fail', lines: [line] };
  }

  if (type === 'meta') {
    const v = metaValue(page.body, cfg.field), want = (cfg.expected || '').trim();
    const ok = v !== null && (cfg.match === 'contains' ? v.toLowerCase().includes(want.toLowerCase()) : v === want);
    const name = cfg.field === 'title' ? 'Title' : 'Meta description';
    return { result: ok ? 'pass' : 'fail', lines: [`${name} on ${pageUrl} is ${v === null ? 'missing' : `"${v}"`}; expected it to ${cfg.match === 'contains' ? 'contain' : 'be'} "${want}"`] };
  }

  return err(`Unknown check type ${type}`);
}

// An issue's result across all its pages: any fail -> fail, else any error -> error, else pass.
async function runIssue(issue, fetchFn) {
  const pages = (issue.pages || []).filter(Boolean);
  if (!pages.length) return { result: 'error', detail: 'No pages listed on this issue' };
  const outs = [];
  for (const p of pages) outs.push(await runCheck(issue.check_type, issue.check_config || {}, p, fetchFn));
  const result = outs.some(o => o.result === 'fail') ? 'fail' : outs.some(o => o.result === 'error') ? 'error' : 'pass';
  return { result, detail: outs.flatMap(o => o.lines).join('\n') };
}

// Run everything once; wait once; rerun only the failures. The second result is final (avoids false alarms).
async function withRetry(items, runFn, waitFn) {
  const out = [];
  for (const it of items) out.push({ item: it, outcome: await runFn(it) });
  const failed = out.filter(o => o.outcome.result === 'fail');
  if (failed.length) { await waitFn(); for (const o of failed) o.outcome = await runFn(o.item); }
  return out;
}

module.exports = { makeFetcher, findArea, extractLinks, sameSite, runCheck, runIssue, withRetry };
