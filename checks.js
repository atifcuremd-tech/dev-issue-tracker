// Check logic for the Dev Issue Tracker. No dependencies (Node 22+ built in fetch).
// A check returns { result: 'pass' | 'fail' | 'error', lines: [...] }.
// 'error' means we could not test (site down, server error, timeout); it never reopens an issue.
// Also loaded by index.html (as window.Checks) so the app knows which audit issues are checked automatically.
(() => {

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// fetcher(url, { follow, size }) -> { status, location, url, body, size }. Throws on network error or timeout.
// size: true downloads the file to measure it in bytes (body is then empty).
function makeFetcher({ pauseMs = 300, timeoutMs = 20000 } = {}) {
  return async (url, { follow = false, size = false } = {}) => {
    if (pauseMs) await sleep(pauseMs);   // be gentle with the site
    const res = await fetch(url, { redirect: follow ? 'follow' : 'manual', headers: { 'user-agent': UA }, signal: AbortSignal.timeout(timeoutMs) });
    const loc = res.headers.get('location');
    const out = { status: res.status, location: loc ? new URL(loc, url).href : null, url: res.url || url, body: '' };
    if (size) out.size = (await res.arrayBuffer()).byteLength;
    else if (follow) out.body = await res.text();
    else await res.body?.cancel();
    return out;
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

// ---------- automatic checks for SEO audit issues ----------
// An audit row names its problem ("Duplicate H1", "Sitemap lists a URL that redirects; Listed twice in the sitemap").
// Each known problem has a test that looks for that same problem on the live site: 'fail' means it is still there.
// Rows whose problem needs a browser or a person (script errors, page speed, claims) stay "check by hand".

const res = (still, line) => ({ result: still ? 'fail' : 'pass', lines: [line] });
const tagsOf = (html, re) => [...html.matchAll(re)].map(m => m[0]);
function attr(tag, name) {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:(["'])([\\s\\S]*?)\\1|([^\\s>]+))`, 'i').exec(tag);
  return m ? decode(m[2] ?? m[3]) : null;
}
const headOf = html => html.split(/<\/head>/i)[0];   // svg icons in the body have their own <title> tags
const canonicals = html => tagsOf(html, /<link\b[^>]*>/gi).filter(t => /^canonical$/i.test(attr(t, 'rel') || '')).map(t => attr(t, 'href') ?? '');
const h1Texts = html => [...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)].map(m => visibleText(m[1]).trim());
const metaCount = (html, name) => tagsOf(html, /<meta\b[^>]*>/gi).filter(t => (attr(t, 'name') || attr(t, 'property') || '').toLowerCase() === name).length;
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

async function onPage(url, f, test) {
  const { page, outcome } = await loadPage(url, f);
  return outcome || test(page.body, page);
}

// Pages the audit says use a file or link: "Used on 2 page(s): /a, /b", "Linked from: /a", "Linked from 228 pages (shared header or footer)".
function usedOn(ev, origin) {
  if (/shared header or footer/i.test(ev)) return [origin + '/'];
  const m = /(?:used on|linked from)[^:]*:\s*(.+)/i.exec(ev);
  return m ? m[1].split(/,\s*/).map(s => s.trim()).filter(s => s.startsWith('/')).map(s => origin + s) : [];
}
// ponytail: plain text search of the page HTML; a file added later by a script will not be seen.
function mentions(html, url) {
  const p = new URL(url).pathname.slice(1).toLowerCase(), low = html.toLowerCase();
  let d = p; try { d = decodeURIComponent(p); } catch {}
  return low.includes(p) || low.includes(d);
}

// A file problem is gone when the file is fine again, or when no page listed in the audit still uses it.
async function fileProblem({ u, ev, origin }, f, whatsWrong) {
  let r; try { r = await f(u, { follow: true, size: true }); } catch (e) { return err(`Could not load ${u} (${e.cause?.code || e.name})`); }
  if (isDown(r.status)) return err(`${u} answered ${r.status} (server problem, not tested)`);
  const bad = whatsWrong(r);
  if (!bad) return res(false, `${u} is fine now (${r.status}${r.size != null ? `, ${Math.round(r.size / 1024)} KB` : ''})`);
  const pages = usedOn(ev, origin);
  if (!pages.length) return res(true, `${u} ${bad}`);
  const still = [];
  for (const p of pages) {
    const { page, outcome } = await loadPage(p, f);
    if (outcome?.result === 'error') return outcome;
    if (page && mentions(page.body, u)) still.push(p);
  }
  return res(still.length > 0, still.length ? `${u} ${bad}. Still used on ${still.join(', ')}` : `${u} ${bad}, but no listed page uses it any more`);
}

async function sitemapCount(u, origin, f) {
  const r = await f(origin + '/sitemap.xml', { follow: true });
  if (r.status !== 200) throw new Error(`sitemap.xml answered ${r.status}`);
  return [...r.body.matchAll(/<loc>([\s\S]*?)<\/loc>/gi)].filter(m => decode(m[1]).trim() === u).length;
}
const inSitemap = test => async (ctx, f) => {
  let n; try { n = await sitemapCount(ctx.u, ctx.origin, f); } catch (e) { return err(`Could not read the sitemap (${e.message})`); }
  return test(n, ctx, f);
};
const listed = (n, u) => `${u} is listed ${n === 0 ? 'not at all' : plural(n, 'time')} in sitemap.xml`;
const listedAnd = statusTest => inSitemap(async (n, { u }, f) => {
  if (!n) return res(false, listed(0, u));
  let r; try { r = await f(u); } catch (e) { return err(`Could not load ${u} (${e.cause?.code || e.name})`); }
  if (isDown(r.status)) return err(`${u} answered ${r.status} (server problem, not tested)`);
  return res(statusTest(r.status), `${listed(n, u)} and answers ${r.status}${r.location ? ' to ' + r.location : ''}`);
});

// "Same title as /other" -> is the title still the same as the other page's?
const sameAs = field => async ({ u, ev, origin }, f) => {
  const m = /same \w+ as (\/[^\s,;]+)/i.exec(ev);
  if (!m) return err('The audit row does not say which page it duplicates');
  const other = origin + m[1].replace(/\.$/, ''), name = field === 'title' ? 'title' : 'meta description';
  const a = await loadPage(u, f); if (a.outcome) return a.outcome;
  let b; try { b = await f(other, { follow: true }); } catch (e) { return err(`Could not load ${other} (${e.cause?.code || e.name})`); }
  if (isDown(b.status)) return err(`${other} answered ${b.status} (server problem, not tested)`);
  if (noSlash(b.url) === noSlash(a.page.url)) return res(false, `${other} now redirects to ${u}`);
  const mine = metaValue(a.page.body, field), theirs = b.status === 200 ? metaValue(b.body, field) : null;
  if (mine === null) return res(true, `${u} has no ${name}`);
  const same = theirs !== null && mine.toLowerCase() === theirs.toLowerCase();
  return res(same, same ? `${u} and ${other} still share the ${name} "${mine}"` : `${u} has its own ${name} now: "${mine}"`);
};
const titleLen = (tooLong, limit) => ({ u }, f) => onPage(u, f, h => {
  const t = metaValue(h, 'title');
  return res(t === null || (tooLong ? t.length > limit : t.length < limit), t === null ? `${u} has no title` : `Title on ${u} is ${t.length} characters: "${t}"`);
});
const imgDims = needLazy => ({ u }, f) => onPage(u, f, h => {
  const imgs = tagsOf(h, /<img\b[^>]*>/gi);
  const missing = imgs.filter(t => attr(t, 'width') === null || attr(t, 'height') === null).length;
  const lazy = imgs.filter(t => (attr(t, 'loading') || '').toLowerCase() === 'lazy').length;
  return res(missing > 0 || (needLazy && lazy === 0), `${missing} of ${plural(imgs.length, '<img> tag')} on ${u} lack width and height; ${lazy} use loading="lazy"`);
});
const canon = (test, what) => ({ u }, f) => onPage(u, f, h => {
  const cs = canonicals(h);
  return res(test(cs), `${u}: ${plural(cs.length, 'canonical tag')}${cs.length ? ': ' + cs.map(c => `"${c}"`).join(', ') : ''}${what ? ` (${what})` : ''}`);
});

const AUTO = {
  'Duplicate H1': ({ u }, f) => onPage(u, f, h => { const n = h1Texts(h).length; return res(n > 1, `${plural(n, 'H1 tag')} on ${u}`); }),
  'Empty H1': ({ u }, f) => onPage(u, f, h => {
    const t = h1Texts(h), empty = t.filter(x => !x).length;
    return res(!t.length || empty > 0, `${u}: ${plural(t.length, 'H1 tag')}, ${empty} empty`);
  }),
  'Title over 65 characters': titleLen(true, 65),
  'Title under 30 characters': titleLen(false, 30),
  'Title shared with other pages': sameAs('title'),
  'Description over 160 characters': ({ u }, f) => onPage(u, f, h => {
    const d = metaValue(h, 'description');
    return res(!d || d.length > 160, d ? `Meta description on ${u} is ${d.length} characters` : `${u} has no meta description`);
  }),
  'Description shared with other pages': sameAs('description'),
  'No JSON-LD': ({ u }, f) => onPage(u, f, h => { const n = tagsOf(h, /<script\b[^>]*application\/ld\+json[^>]*>/gi).length; return res(!n, `${plural(n, 'JSON-LD block')} on ${u}`); }),
  'No visible FAQ section': ({ u }, f) => onPage(u, f, h => {
    const faq = [...h.matchAll(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/gi)].some(m => /faq|frequently asked/i.test(visibleText(m[1])));
    return res(!faq, `${faq ? 'An' : 'No'} FAQ heading on ${u}`);
  }),
  'Open Graph tags missing': ({ u }, f) => onPage(u, f, h => {
    const t = metaCount(h, 'og:title'), i = metaCount(h, 'og:image');
    return res(!t || !i, `${u}: og:title ${t ? 'present' : 'missing'}, og:image ${i ? 'present' : 'missing'}`);
  }),
  'Phone link not in +1 format': ({ u }, f) => onPage(u, f, h => {
    const tels = tagsOf(h, /<a\b[^>]*>/gi).map(t => attr(t, 'href') || '').filter(x => /^tel:/i.test(x));
    const bad = tels.filter(t => !/^tel:\+1\d{10}$/i.test(t.replace(/[\s().-]/g, '')));
    return res(bad.length > 0, bad.length ? `Phone links not in +1 format on ${u}: ${[...new Set(bad)].join(', ')}` : `All ${plural(tels.length, 'phone link')} on ${u} use +1`);
  }),
  'Images without dimensions': imgDims(false),
  'Images without dimensions and no lazy-loading': imgDims(true),
  'Image over 250 KB': (ctx, f) => fileProblem(ctx, f, r => r.status !== 200 ? `answers ${r.status}` : r.size > 250 * 1024 ? `is ${Math.round(r.size / 1024)} KB` : ''),
  'Broken image or file': (ctx, f) => fileProblem(ctx, f, r => r.status === 200 ? '' : `answers ${r.status}`),
  'Broken font': (ctx, f) => AUTO['Broken image or file'](ctx, f),
  'Broken script': (ctx, f) => AUTO['Broken image or file'](ctx, f),
  'Broken internal link': (ctx, f) => AUTO['Broken image or file'](ctx, f),
  'Third-party request fails': (ctx, f) => AUTO['Broken image or file'](ctx, f),
  'Linked live page missing from the sitemap': inSitemap((n, { u }) => res(n === 0, listed(n, u))),
  'Listed twice in the sitemap': inSitemap((n, { u }) => res(n > 1, listed(n, u))),
  'PDF listed in the HTML sitemap': inSitemap((n, { u }) => res(n > 0, listed(n, u))),
  'Sitemap lists a URL that redirects': listedAnd(s => s >= 300 && s < 400),
  'Sitemap lists a page that returns 404': listedAnd(s => s === 404 || s === 410),
  'Canonical URL padded with spaces': canon(cs => cs.some(c => c !== c.trim()), 'spaces around the address'),
  'No canonical tag': canon(cs => !cs.length),
  'Two canonical tags, one pointing to a different page': canon(cs => cs.length > 1),
  'Empty canonical tag before the real one': canon(cs => cs.some(c => !c.trim()), 'an empty one counts as the problem'),
  'Duplicate head tags from the state page template': ({ u }, f) => onPage(u, f, h => {
    const head = headOf(h), t = (head.match(/<title[\s>]/gi) || []).length, d = metaCount(head, 'description'), c = canonicals(head).length;
    return res(t > 1 || d > 1 || c > 1, `Head of ${u}: ${plural(t, 'title')}, ${plural(d, 'meta description')}, ${plural(c, 'canonical tag')}`);
  }),
  'Internal link points to a URL that redirects': async ({ u, ev, origin }, f) => {
    let r; try { r = await f(u); } catch (e) { return err(`Could not load ${u} (${e.cause?.code || e.name})`); }
    if (isDown(r.status)) return err(`${u} answered ${r.status} (server problem, not tested)`);
    if (!(r.status >= 300 && r.status < 400)) return res(false, `${u} answers ${r.status} directly now`);
    const pages = usedOn(ev, origin), still = [];
    for (const p of pages) {
      const { page, outcome } = await loadPage(p, f);
      if (outcome?.result === 'error') return outcome;
      if (page && extractLinks(page.body, page.url).includes(norm(u))) still.push(p);
    }
    return res(still.length > 0 || !pages.length, `${u} redirects to ${r.location}. ${still.length ? 'Still linked from ' + still.join(', ') : pages.length ? 'No listed page links to it any more' : ''}`.trim());
  },
  // O8 rows: a menu link in the shared header wraps its label in <h4>.
  'Change <h4> to <span class="menu-title">': ({ cols, origin }, f) => onPage(origin + '/', f, (h, page) => {
    const want = noSlash(cols['Link URL']);
    const hits = [...h.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)].filter(m => {
      const href = attr(' ' + m[1], 'href'); try { return href && noSlash(new URL(href, page.url).href) === want; } catch { return false; }
    });
    const bad = hits.some(m => /<h4[\s>]/i.test(m[2]));
    return res(bad, hits.length ? `Menu link to ${want} ${bad ? 'still has its label in <h4>' : 'no longer uses <h4>'}` : `No link to ${want} on the homepage any more`);
  }),
};

const auditCols = issue => Object.fromEntries(issue?.audit?.columns || []);
const partsOf = issue => { const c = auditCols(issue); return (c.Problem || c['Change or keep'] || '').split(/;\s*/).map(p => p.replace(/\s*\([^)]*\)$/, '').trim()).filter(Boolean); };
// The audit problem when every part of it can be tested automatically, else null.
function autoProblem(issue) {
  const c = auditCols(issue), parts = partsOf(issue), url = c['URL or location'] || c['Link URL'] || '';
  return parts.length && /^https?:\/\//.test(url) && parts.every(p => AUTO[p]) ? (c.Problem || c['Change or keep']) : null;
}
async function runAuto(issue, f) {
  const c = auditCols(issue), u = (c['URL or location'] || '').trim();
  const ctx = { cols: c, u, ev: c['Current value / evidence'] || '', origin: new URL(u || c['Link URL']).origin };
  const outs = [];
  for (const p of partsOf(issue)) outs.push(await AUTO[p](ctx, f));
  return outs;
}

// An issue's result across all its pages: any fail -> fail, else any error -> error, else pass.
async function runIssue(issue, fetchFn) {
  const outs = [];
  if (issue.check_type === 'manual' && autoProblem(issue)) outs.push(...await runAuto(issue, fetchFn));
  else {
    const pages = (issue.pages || []).filter(Boolean);
    if (!pages.length) return { result: 'error', detail: 'No pages listed on this issue' };
    for (const p of pages) outs.push(await runCheck(issue.check_type, issue.check_config || {}, p, fetchFn));
  }
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

const api = { makeFetcher, findArea, extractLinks, sameSite, runCheck, runIssue, withRetry, autoProblem, AUTO };
if (typeof module !== 'undefined') module.exports = api; else window.Checks = api;
})();
