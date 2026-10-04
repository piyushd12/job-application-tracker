/**
 * Deterministic job-page extraction (no network, no AI).
 *
 * Every field takes the first non-empty value from three layers:
 *   1. a site reader picked by hostname,
 *   2. schema.org JobPosting JSON-LD,
 *   3. generic page heuristics.
 *
 * Loaded as a content script (exposes globalThis.JobExtract) and by Node tests (module.exports).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.JobExtract = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_DESCRIPTION = 50000;
  const MAX_FIELD = 200;

  // ===== Text and DOM helpers ==============================================

  function clean(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim();
  }

  /** NBSP-like spaces → space, Unicode dashes → "-". */
  function normalizeText(value) {
    return String(value ?? '').replace(/[    ]/g, ' ').replace(/[‐-―−]/g, '-');
  }

  function textOf(el) {
    if (!el) return '';
    return clean(typeof el.innerText === 'string' ? el.innerText : el.textContent);
  }

  function query(doc, selector) {
    try {
      return doc.querySelector(selector);
    } catch {
      return null;
    }
  }

  function queryAll(doc, selector) {
    try {
      return Array.from(doc.querySelectorAll(selector));
    } catch {
      return [];
    }
  }

  /** Text of the first selector that matches a non-empty element. */
  function pick(doc, ...selectors) {
    for (const selector of selectors) {
      const text = textOf(query(doc, selector));
      if (text) return text;
    }
    return '';
  }

  /** Text of every element matching any selector, joined. */
  function pickAll(doc, ...selectors) {
    return selectors.flatMap((s) => queryAll(doc, s)).map(textOf).filter(Boolean).join(' · ');
  }

  /** Like pick, but several links or list items inside the match (multiple locations) become "A; B". */
  function pickPlaces(doc, ...selectors) {
    for (const selector of selectors) {
      const el = query(doc, selector);
      if (!el) continue;
      const items = [...new Set(queryAll(el, 'a, li, dd').map(textOf).filter(Boolean))];
      const text = items.length > 1 ? items.join('; ') : textOf(el);
      if (text) return text;
    }
    return '';
  }

  function pickAttr(doc, selector, attribute) {
    const el = query(doc, selector);
    return clean(el && el.getAttribute(attribute));
  }

  /** First short (label-sized) text among the selectors, skipping bare "Location" headings. */
  function pickShort(doc, selectors, max = 120) {
    for (const selector of selectors) {
      for (const el of queryAll(doc, selector)) {
        const text = stripLabel(textOf(el), 'locations?');
        if (text && text.length <= max && !/^locations?$/i.test(text)) return text;
      }
    }
    return '';
  }

  function meta(doc, name) {
    return pickAttr(doc, `meta[property="${name}"], meta[name="${name}"]`, 'content');
  }

  function stripLabel(text, label) {
    return clean(String(text || '').replace(new RegExp(`^\\s*${label}\\s*:?\\s*`, 'i'), ''));
  }

  /** Value next to a label such as "Location: Pune" or <dt>Location</dt><dd>Pune</dd>. */
  function labelValue(doc, labels) {
    const names = labels.map((l) => l.toLowerCase());
    const candidates = queryAll(doc, 'dt, th, label, strong, b, h2, h3, h4, h5, p, li, span, div').slice(0, 4000);
    for (const el of candidates) {
      if (el.children.length > 2) continue;
      const text = clean(el.textContent);
      if (!text || text.length > 160) continue;
      const lower = text.toLowerCase();
      for (const name of names) {
        if (lower === name || lower === `${name}:`) {
          const value = clean(el.nextElementSibling && el.nextElementSibling.textContent);
          if (value && value.length <= 120) return value;
        } else if (lower.startsWith(`${name}:`)) {
          const value = clean(text.slice(name.length + 1));
          if (value) return value;
        }
      }
    }
    return '';
  }

  function titleCase(value) {
    return clean(value).replace(/(^|\s)(\p{L})/gu, (m, space, letter) => space + letter.toUpperCase());
  }

  function hostnameOf(url) {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch {
      return '';
    }
  }

  function hostIs(host, domain) {
    return host === domain || host.endsWith(`.${domain}`);
  }

  function safely(fn) {
    try {
      return fn();
    } catch {
      return null;
    }
  }

  const NAMED_ENTITIES = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '-', mdash: '-',
    lsquo: "'", rsquo: "'", ldquo: '"', rdquo: '"', bull: '•', hellip: '…', rupee: '₹', euro: '€', pound: '£',
  };

  function decodeEntities(value) {
    return String(value ?? '').replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, code) => {
      if (code[0] !== '#') return NAMED_ENTITIES[code.toLowerCase()] ?? match;
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      try {
        return String.fromCodePoint(n);
      } catch {
        return match;
      }
    });
  }

  /** Plain text from an HTML string without touching the DOM (nothing is parsed or executed). */
  function htmlToText(html) {
    const decoded = decodeEntities(html);
    return clean(decodeEntities(decoded.replace(/<(?:br|\/p|\/li|\/div|\/h\d)[^>]*>/gi, '\n').replace(/<[^>]*>/g, ' ')));
  }

  function today() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  // ===== Source ============================================================

  const SOURCES = [
    ['linkedin.com', 'LinkedIn'], ['naukri.com', 'Naukri'], [/(^|\.)indeed\./, 'Indeed'],
    [/(^|\.)glassdoor\./, 'Glassdoor'], ['myworkdayjobs.com', 'Workday'], ['myworkdaysite.com', 'Workday'],
    ['greenhouse.io', 'Greenhouse'], ['lever.co', 'Lever'], ['ashbyhq.com', 'Ashby'],
    ['smartrecruiters.com', 'SmartRecruiters'], ['icims.com', 'iCIMS'], ['wellfound.com', 'Wellfound'],
    ['angel.co', 'Wellfound'], ['instahyre.com', 'Instahyre'], ['foundit.in', 'Foundit'], ['foundit.sg', 'Foundit'],
    ['cutshort.io', 'Cutshort'], ['hirist.tech', 'Hirist'], ['hirist.com', 'Hirist'],
    ['internshala.com', 'Internshala'], ['taleo.net', 'Taleo'], ['successfactors.com', 'SuccessFactors'],
    ['successfactors.eu', 'SuccessFactors'], ['oraclecloud.com', 'Oracle Cloud'], ['bamboohr.com', 'BambooHR'],
    ['workable.com', 'Workable'], ['recruitee.com', 'Recruitee'], ['jobvite.com', 'Jobvite'],
    ['teamtailor.com', 'Teamtailor'], ['zohorecruit.com', 'Zoho Recruit'], ['zohorecruit.in', 'Zoho Recruit'],
  ];
  const SOURCE_NAMES = [...new Set(SOURCES.map(([, name]) => name)), 'Company Site'];

  function sourceFromHost(hostname) {
    const host = String(hostname || '').toLowerCase();
    for (const [match, name] of SOURCES) {
      if (typeof match === 'string' ? hostIs(host, match) : match.test(host)) return name;
    }
    return 'Company Site';
  }

  // ===== Canonical URL =====================================================

  /** Keep in sync with TRACKING_PARAMS in extension/lib/sheets.js. */
  const TRACKING_PARAMS = new Set([
    'ref', 'refid', 'ref_src', 'referrer', 'trk', 'trkinfo', 'trackingid', 'gh_src',
    'lever-source', 'lever-origin', 'fbclid', 'gclid', 'dclid', 'msclkid', 'yclid',
    'mc_cid', 'mc_eid', '_hsenc', '_hsmi', 'igshid',
  ]);

  const PATH_ID_HOSTS = ['naukri.com', 'myworkdayjobs.com', 'myworkdaysite.com', 'lever.co', 'ashbyhq.com'];

  function canonicalUrl(href) {
    let url;
    try {
      url = new URL(String(href || '').trim());
    } catch {
      return clean(href);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return url.href;
    const host = url.hostname;

    if (hostIs(host, 'linkedin.com')) {
      const fromPath = url.pathname.match(/\/jobs\/view\/(?:[^/]*-)?(\d+)/);
      const id = (fromPath && fromPath[1]) || url.searchParams.get('currentJobId');
      if (id && /^\d+$/.test(id)) return `https://www.linkedin.com/jobs/view/${id}`;
    }
    if (/(^|\.)indeed\./.test(host)) {
      const jk = url.searchParams.get('jk') || url.searchParams.get('vjk');
      if (jk && /^[\w-]+$/.test(jk)) return `https://${host}/viewjob?jk=${jk}`;
    }
    // Workday serves the same job under every locale prefix (/en-US/, /de-DE/, …) and without one.
    if (hostIs(host, 'myworkdayjobs.com') || hostIs(host, 'myworkdaysite.com')) {
      url.pathname = url.pathname.replace(/^\/[a-z]{2}-[a-z]{2}(?=\/)/i, '');
    }
    // On these sites the path alone identifies the job; the query only carries search/session state.
    if (PATH_ID_HOSTS.some((domain) => hostIs(host, domain)) || (hostIs(host, 'greenhouse.io') && /\/jobs\/\d+/.test(url.pathname))) {
      url.search = '';
    }

    const kept = [...url.searchParams]
      .filter(([key]) => {
        const k = key.toLowerCase();
        return !k.startsWith('utm_') && !TRACKING_PARAMS.has(k);
      })
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const search = kept.length ? `?${new URLSearchParams(kept)}` : '';
    const path = url.pathname.replace(/\/apply\/?$/i, '').replace(/\/+$/, '');
    return `${url.protocol}//${url.host}${path}${search}`;
  }

  // ===== YOE ===============================================================

  const NUMBER_WORDS = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
    eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
    eighteen: 18, nineteen: 19, twenty: 20,
  };
  const WORDS = Object.keys(NUMBER_WORDS).join('|');
  // Not preceded by a digit, dot or dash, so "5" in "2-5 years" or "2015" never starts a match.
  const NUM = String.raw`(?<![\d.-])(\d{1,2}(?:\.\d)?)`;
  const UNIT = String.raw`(?:years?|yrs?)\b(?:\(s\))?`;
  const YOE_PATTERNS = [
    { re: new RegExp(String.raw`${NUM}\s*(?:-|to)\s*(\d{1,2}(?:\.\d)?)\s*\+?\s*${UNIT}`, 'g'), format: (m) => `${m[1]}-${m[2]} yrs` },
    { re: new RegExp(String.raw`(?:at\s+least|minimum(?:\s+of)?|min\.?(?:\s+of)?)\s*${NUM}\s*\+?\s*${UNIT}`, 'g'), format: (m) => `${m[1]}+ yrs` },
    { re: new RegExp(String.raw`${NUM}\s*\+\s*${UNIT}`, 'g'), format: (m) => `${m[1]}+ yrs` },
    { re: new RegExp(String.raw`${NUM}\s*${UNIT}`, 'g'), format: (m) => (m[1] === '1' ? '1 yr' : `${m[1]} yrs`) },
  ];
  const EXPERIENCE_RE = /experien|\bexp\b/;
  const NOT_EXPERIENCE_AFTER_RE = /^\s*(?:old|ago|of age)\b/;
  const FRESHER_RE = /\b(?:freshers?|entry[- ]level|new[- ]grad(?:uate)?s?|recent graduates?|graduate trainee)\b/;

  function normalizeYoeText(text) {
    return normalizeText(text).toLowerCase()
      .replace(new RegExp(String.raw`\b(?:${WORDS})\s*\(\s*(\d{1,2})\s*\)`, 'g'), '$1')
      .replace(new RegExp(String.raw`\b(${WORDS})\b`, 'g'), (word) => String(NUMBER_WORDS[word]))
      .replace(/\s+/g, ' ');
  }

  /**
   * Years of experience as "2-5 yrs", "3+ yrs", "3 yrs", "Fresher" or "N/A".
   * The earliest valid match wins. With requireContext (the default) a match only counts when
   * "experience" appears within ~90 characters; site fields that are already about experience skip that.
   */
  function extractYOE(text, { requireContext = true } = {}) {
    const s = normalizeYoeText(text);
    const candidates = [];
    YOE_PATTERNS.forEach((pattern, order) => {
      for (const match of s.matchAll(pattern.re)) candidates.push({ match, pattern, order });
    });
    candidates.sort((a, b) => a.match.index - b.match.index || a.order - b.order);

    for (const { match, pattern } of candidates) {
      if (isValidYoe(s, match, requireContext)) return pattern.format(match);
    }
    return FRESHER_RE.test(s) ? 'Fresher' : 'N/A';
  }

  function isValidYoe(s, match, requireContext) {
    const numbers = [match[1], match[2]].filter(Boolean).map(Number);
    if (numbers.some((n) => n > 30)) return false;
    if (numbers.length === 2 && !(numbers[0] < numbers[1])) return false;
    const end = match.index + match[0].length;
    if (NOT_EXPERIENCE_AFTER_RE.test(s.slice(end, end + 12))) return false;
    return !requireContext || EXPERIENCE_RE.test(s.slice(Math.max(0, match.index - 90), end + 90));
  }

  /** "N/A" means "keep looking in the next layer". */
  function usefulYoe(value) {
    return value && value !== 'N/A' ? value : '';
  }

  // ===== Work mode =========================================================

  // Order is the priority: Hybrid > Remote > On-site.
  const MODE_LOOSE = [
    ['Hybrid', /\bhybrid\b/i],
    ['Remote', /\b(?:remote|work from home|wfh|telecommute|work from anywhere)\b/i],
    ['On-site', /\b(?:on-?site|in[- ]office|in[- ]person|work from office|wfo)\b/i],
  ];
  const MODE_STRICT = [
    ['Hybrid', /\bhybrid\b(?![- ](?:cloud|apps?|mobile|infrastructure|environments?|solutions?)\b)/i],
    ['Remote', /(?:\bfully remote|\b100% remote|\bremote[- ]first|\bremote (?:position|role|job|opportunity)|\bwork from home|\bwork from anywhere)\b/i],
    ['On-site', /\b(?:work from office|on-?site (?:role|position|job)|in-office)\b/i],
  ];

  function firstMode(text, rules) {
    const t = normalizeText(text);
    if (!t.trim()) return '';
    for (const [mode, re] of rules) if (re.test(t)) return mode;
    return '';
  }

  /**
   * Work mode from explicit fields first, then loose matching on location/header text,
   * then strict phrases in the description. A plain string is treated as location text.
   */
  function workModeFrom(input) {
    const parts = typeof input === 'string' ? { location: input } : input || {};
    return firstMode(parts.explicit, MODE_LOOSE)
      || firstMode(`${parts.location || ''} ${parts.header || ''}`, MODE_LOOSE)
      || firstMode(parts.description, MODE_STRICT)
      || 'N/A';
  }

  // ===== Salary ============================================================

  const CURRENCY = String.raw`(?:₹|rs\.?|inr|usd|us\$|\$|€|eur|£|gbp)`;
  const AMOUNT = String.raw`\d[\d,]*(?:\.\d+)?\s*(?:k|l|lakhs?|lacs?|lpa|cr|crores?|m|mn)?\b`;
  const PERIOD = String.raw`(?:\s*(?:lpa|p\.a\.|pa\b|per\s+(?:annum|year|month|hour)|\/\s*(?:year|yr|annum|month|mo|hour|hr)\b|a\s+(?:year|month)\b|an\s+hour\b))?`;
  const SALARY_RE = new RegExp([
    String.raw`${CURRENCY}\s*${AMOUNT}(?:\s*(?:-|to)\s*${CURRENCY}?\s*${AMOUNT})?${PERIOD}`,
    String.raw`(?<![\d.])\d{1,3}(?:\.\d+)?\s*(?:-|to)\s*\d{1,3}(?:\.\d+)?\s*(?:lpa|lakhs?|lacs?)(?:\s+per\s+annum)?\b`,
    String.raw`(?<![\d.])\d{1,3}(?:\.\d+)?\s*(?:lpa|lakhs?\s+per\s+annum)\b`,
  ].join('|'), 'gi');
  const SALARY_KEYWORD_RE = /salary|\bctc\b|compensation|\bpay\b|package|stipend|\blpa\b|remuneration|per annum/i;
  const UNDISCLOSED_RE = /not disclosed|undisclosed|competitive|as per (?:industry|company)|negotiable|best in (?:the )?industry/i;

  /** An amount from free text, accepted only within ~60 characters of a salary keyword. */
  function salaryFromText(text) {
    const s = normalizeText(text);
    for (const match of s.matchAll(SALARY_RE)) {
      const start = match.index;
      const end = start + match[0].length;
      if (SALARY_KEYWORD_RE.test(s.slice(Math.max(0, start - 60), end + 60))) {
        return clean(match[0]).replace(/[\s,;:-]+$/, '');
      }
    }
    return '';
  }

  function siteSalary(text) {
    const value = clean(normalizeText(text));
    return UNDISCLOSED_RE.test(value) ? '' : value;
  }

  function toNumber(value) {
    const n = typeof value === 'number' ? value : parseFloat(String(value ?? '').replace(/,/g, ''));
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  /** schema.org MonetaryAmount → "12-18 LPA" for yearly INR, otherwise "USD 120,000-150,000 / year". */
  function salaryFromJsonLd(value) {
    const amount = Array.isArray(value) ? value[0] : value;
    if (!amount) return '';
    if (typeof amount !== 'object') return clean(amount);

    const currency = clean(amount.currency || amount.salaryCurrency).toUpperCase();
    const q = amount.value !== null && typeof amount.value === 'object' ? amount.value : { value: amount.value };
    const unit = clean(q.unitText || amount.unitText).toUpperCase();
    const min = toNumber(q.minValue ?? q.value ?? q.median);
    const max = toNumber(q.maxValue);
    const low = min || max;
    const high = min && max && max !== min ? max : 0;
    if (!low) return '';

    if (currency === 'INR' && (!unit || unit === 'YEAR') && low >= 100000) {
      const lakhs = (n) => String(Math.round(n / 10000) / 10);
      return high ? `${lakhs(low)}-${lakhs(high)} LPA` : `${lakhs(low)} LPA`;
    }
    const fmt = (n) => n.toLocaleString('en-US');
    const per = { YEAR: ' / year', MONTH: ' / month', WEEK: ' / week', DAY: ' / day', HOUR: ' / hour' }[unit] || '';
    return `${currency ? `${currency} ` : ''}${high ? `${fmt(low)}-${fmt(high)}` : fmt(low)}${per}`;
  }

  // ===== JSON-LD ===========================================================

  function parseLooseJson(text) {
    const raw = String(text || '').trim();
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      // Common breakage: raw control characters inside strings, HTML comment / CDATA wrappers.
    }
    try {
      return JSON.parse(raw
        .replace(/^\s*(?:<!--|\/\/\s*<!\[CDATA\[)|(?:-->|\/\/\s*\]\]>)\s*$/g, '')
        .replace(/[\u0000-\u001f]+/g, ' ')
        .replace(/,\s*([}\]])/g, '$1')); // trailing commas
    } catch {
      return null;
    }
  }

  function isJobPosting(node) {
    return [].concat(node['@type'] || []).some((t) => /(^|\/)jobposting$/i.test(String(t)));
  }

  function collectPostings(node, out, depth) {
    if (!node || typeof node !== 'object' || depth > 6) return;
    if (Array.isArray(node)) {
      node.forEach((child) => collectPostings(child, out, depth + 1));
      return;
    }
    if (isJobPosting(node)) out.push(node);
    if (node['@graph']) collectPostings(node['@graph'], out, depth + 1);
    if (node.mainEntity) collectPostings(node.mainEntity, out, depth + 1);
  }

  /** Raw JobPosting objects from every JSON-LD block (arrays, @graph and mainEntity included). */
  function readJsonLdPostings(doc) {
    const postings = [];
    for (const script of queryAll(doc, 'script[type="application/ld+json"]')) {
      collectPostings(parseLooseJson(script.textContent), postings, 0);
    }
    return postings;
  }

  function orgName(org) {
    const value = Array.isArray(org) ? org[0] : org;
    if (!value) return '';
    return clean(decodeEntities(typeof value === 'object' ? value.name : value));
  }

  function jsonLdLocation(posting, remote) {
    const places = [].concat(posting.jobLocation || []).map((place) => {
      const address = place && typeof place === 'object' ? place.address || place : place;
      if (!address) return '';
      if (typeof address !== 'object') return clean(address);
      const country = address.addressCountry && typeof address.addressCountry === 'object'
        ? address.addressCountry.name
        : address.addressCountry;
      const parts = [address.addressLocality, address.addressRegion, country].map(clean).filter(Boolean);
      return [...new Set(parts)].join(', ');
    }).filter(Boolean);
    if (places.length) return [...new Set(places)].join('; ');
    if (!remote) return '';

    const regions = [].concat(posting.applicantLocationRequirements || [])
      .map((r) => clean(r && typeof r === 'object' ? r.name : r))
      .filter(Boolean);
    return regions.length ? `Remote – ${regions.join(', ')}` : 'Remote';
  }

  function yoeFromJsonLd(requirements) {
    const req = Array.isArray(requirements) ? requirements[0] : requirements;
    if (!req) return '';
    if (typeof req !== 'object') return usefulYoe(extractYOE(req, { requireContext: false }));
    const years = Math.floor(toNumber(req.monthsOfExperience) / 12);
    if (years) return `${years}+ yrs`;
    return usefulYoe(extractYOE(req.description || req.name || '', { requireContext: false }));
  }

  function mapPosting(posting) {
    const remote = [].concat(posting.jobLocationType || []).some((t) => /telecommute/i.test(String(t)));
    return {
      role: clean(decodeEntities(posting.title || posting.name)),
      company: orgName(posting.hiringOrganization),
      location: jsonLdLocation(posting, remote),
      workMode: remote ? 'Remote' : '',
      salary: salaryFromJsonLd(posting.baseSalary) || salaryFromJsonLd(posting.estimatedSalary),
      yoe: yoeFromJsonLd(posting.experienceRequirements),
      description: htmlToText(posting.description),
    };
  }

  function words(value) {
    return clean(String(value || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' '));
  }

  /** True when two job titles plausibly describe the same job (containment or ≥50% shared words). */
  function sameRole(a, b) {
    const x = words(a);
    const y = words(b);
    if (!x || !y || x.includes(y) || y.includes(x)) return true;
    const xs = new Set(x.split(' '));
    const ys = new Set(y.split(' '));
    const shared = [...xs].filter((w) => ys.has(w)).length;
    return shared / new Set([...xs, ...ys]).size >= 0.5;
  }

  /**
   * The posting to use. SPAs can leave JSON-LD from a previously viewed job in the DOM, so when a
   * site reader found the visible role, only a posting with a matching title is trusted.
   */
  function pickPosting(postings, visibleRole) {
    if (!visibleRole) return postings[0] || {};
    return postings.find((p) => sameRole(p.role, visibleRole)) || {};
  }

  // ===== Generic heuristics ================================================

  const CAREERS_HEADING_RE = /^(?:careers?|jobs?|join us|join our team|open positions|current openings|work with us)\b|\bcareers$/i;
  const CAREER_WORDS_RE = /\b(?:careers?|jobs?|job board|is hiring|hiring|open positions?)\b/gi;
  const GENERIC_SUBDOMAINS = new Set(['www', 'careers', 'career', 'jobs', 'job', 'apply', 'boards', 'talent', 'join', 'work', 'hiring', 'recruiting', 'm']);
  const SECOND_LEVEL_DOMAINS = new Set(['co', 'com', 'org', 'net', 'ac', 'gov', 'edu']);

  function stripCareerWords(value) {
    return clean(String(value || '').replace(CAREER_WORDS_RE, ' ').replace(/^[\s|:–-]+|[\s|:–-]+$/g, ''));
  }

  /** "Role at Company", "Job Application for Role at Company", "Role | Company", "Role - Company". */
  function splitTitle(raw) {
    const title = clean(decodeEntities(raw));
    if (!title) return null;
    let m = title.match(/^job application for\s+(.+?)\s+at\s+(.+)$/i);
    if (m) return { role: m[1], company: stripCareerWords(m[2]) };

    const parts = title.split(/\s+[|·•–—-]\s+/).map(clean).filter(Boolean);
    m = parts[0].match(/^(.+?)\s+at\s+(.+)$/i);
    if (m) return { role: CAREERS_HEADING_RE.test(m[1]) ? '' : m[1], company: stripCareerWords(m[2]) };
    const role = CAREERS_HEADING_RE.test(parts[0]) ? '' : parts[0];
    const company = parts.slice(1).map(stripCareerWords).find(Boolean) || '';
    return { role, company };
  }

  /** careers.acme.co.in → "Acme". */
  function companyFromHost(hostname) {
    const labels = String(hostname || '').toLowerCase().split('.').filter(Boolean);
    if (labels.length > 1) labels.pop();
    if (labels.length > 1 && SECOND_LEVEL_DOMAINS.has(labels[labels.length - 1])) labels.pop();
    const name = labels.filter((l) => !GENERIC_SUBDOMAINS.has(l)).pop() || '';
    return titleCase(name.replace(/[-_]+/g, ' '));
  }

  function companyFromPath(url, index = 0) {
    const segment = safely(() => new URL(url).pathname.split('/').filter(Boolean)[index]);
    return segment ? titleCase(decodeURIComponent(segment).replace(/[-_]+/g, ' ')) : '';
  }

  function longestText(doc, selectors, minLength) {
    let best = '';
    for (const selector of selectors) {
      for (const el of queryAll(doc, selector)) {
        const text = textOf(el);
        if (text.length > best.length) best = text;
      }
    }
    return best.length >= minLength ? best : '';
  }

  function genericDescription(doc) {
    return longestText(doc, [
      '[itemprop="description"]', '[class*="description"]', '[id*="description"]', '[class*="Description"]',
      '[class*="job-details"]', '[class*="jobDetails"]',
    ], 200) || longestText(doc, ['article', 'main', '[role="main"]'], 1) || textOf(doc.body);
  }

  function readGeneric(doc, url) {
    const host = hostnameOf(url);
    const title = splitTitle(meta(doc, 'og:title')) || splitTitle(doc.title) || {};
    const h1 = pick(doc, 'h1');
    const siteName = meta(doc, 'og:site_name');
    return {
      role: (h1 && h1.length <= 150 && !CAREERS_HEADING_RE.test(h1) ? h1 : '') || title.role || '',
      company: (siteName && siteName !== sourceFromHost(host) ? stripCareerWords(siteName) : '')
        || title.company
        || companyFromHost(host),
      location: pickShort(doc, [
        '[itemprop="jobLocation"]', '[data-testid*="location"]', '[data-automation-id*="location"]',
        '[class*="location"]', '[class*="Location"]', '[id*="location"]',
      ]) || labelValue(doc, ['Location', 'Job Location', 'Work Location', 'Office Location']),
      header: `${doc.title || ''} ${h1}`,
    };
  }

  // ===== Site readers ======================================================
  //
  // Each field lists fallback selectors, most stable first: data-testid / data-automation-id /
  // data-test / data-qa / itemprop / id, then semantic tags, then partial class names.
  // `companyFallback` (from the URL) is used only after JSON-LD has had its turn.

  function firstSegment(value) {
    return clean(String(value || '').split(/\s+·\s+/)[0]);
  }

  const SITE_READERS = [
    {
      name: 'LinkedIn',
      matches: (host) => hostIs(host, 'linkedin.com'),
      isJobPage: (doc, url) => /\/jobs\/view\/|[?&]currentJobId=\d+/.test(url),
      read: (doc) => ({
        role: pick(doc,
          '.job-details-jobs-unified-top-card__job-title h1', '.job-details-jobs-unified-top-card__job-title',
          '.jobs-unified-top-card__job-title', '.top-card-layout__title', 'h1.topcard__title'),
        company: pick(doc,
          '.job-details-jobs-unified-top-card__company-name a', '.job-details-jobs-unified-top-card__company-name',
          '.jobs-unified-top-card__company-name a', '.topcard__org-name-link', '.topcard__flavor a'),
        location: firstSegment(pick(doc,
          '.job-details-jobs-unified-top-card__primary-description-container .tvm__text',
          '.job-details-jobs-unified-top-card__tertiary-description-container .tvm__text',
          '.jobs-unified-top-card__bullet', '.topcard__flavor--bullet')),
        workMode: pickAll(doc,
          '.job-details-preferences-and-skills__pill', '.job-details-jobs-unified-top-card__workplace-type',
          '.jobs-unified-top-card__workplace-type'),
        header: pick(doc,
          '.job-details-jobs-unified-top-card__container--two-pane', '.job-details-jobs-unified-top-card__primary-description-container',
          '.top-card-layout__entity-info'),
        description: pick(doc, '#job-details', '.jobs-description__content', '.jobs-box__html-content',
          '.show-more-less-html__markup', '.description__text'),
      }),
    },
    {
      name: 'Naukri',
      matches: (host) => hostIs(host, 'naukri.com'),
      isJobPage: (doc, url) => /job-listings-/.test(url) || Boolean(query(doc, '[class*="jd-header-title"]')),
      read: (doc) => ({
        role: pick(doc, 'h1[class*="jd-header-title"]', '[class*="jd-header-title"]', 'h1'),
        company: pick(doc, '[class*="jd-header-comp-name"] > a', '[class*="jd-header-comp-name"] a', '[class*="jd-header-comp-name"]'),
        location: pickPlaces(doc, '[class*="jhc__location"]', '[class*="__location"]', '.location'),
        salary: pick(doc, '[class*="jhc__salary"]', '[class*="__salary"]', '.salary'),
        yoe: pick(doc, '[class*="jhc__exp"]', '[class*="__exp"]', '.exp'),
        workMode: pick(doc, '[class*="jhc__wfhmode"]', '[class*="wfhmode"]'),
        description: pick(doc, '[class*="JDC__dang-inner-html"]', '[class*="job-desc"]', '.job-desc'),
      }),
    },
    {
      name: 'Indeed',
      matches: (host) => /(^|\.)indeed\./.test(host),
      isJobPage: (doc, url) => /[?&](?:jk|vjk)=|\/viewjob/.test(url) || Boolean(query(doc, '[data-testid="jobsearch-JobInfoHeader-title"]')),
      read: (doc) => ({
        role: pick(doc, '[data-testid="jobsearch-JobInfoHeader-title"]', 'h1.jobsearch-JobInfoHeader-title', '.jobsearch-JobInfoHeader-title')
          .replace(/\s*-\s*job post$/i, ''),
        company: pick(doc, '[data-testid="inlineHeader-companyName"] a', '[data-testid="inlineHeader-companyName"]',
          '[data-company-name="true"]', '.jobsearch-CompanyInfoContainer a'),
        location: pick(doc, '[data-testid="inlineHeader-companyLocation"]', '[data-testid="job-location"]',
          '[data-testid="jobsearch-JobInfoHeader-companyLocation"]'),
        salary: pick(doc, '#salaryInfoAndJobType [class*="salary"]', '#salaryInfoAndJobType span', '[data-testid="jobsearch-OtherJobDetailsContainer"] [class*="salary"]'),
        header: pick(doc, '[data-testid="jobsearch-JobInfoHeader-subtitle"]', '.jobsearch-JobInfoHeader-subtitle', '#jobDetailsSection'),
        description: pick(doc, '#jobDescriptionText', '[data-testid="jobDescriptionText"]'),
      }),
    },
    {
      name: 'Glassdoor',
      matches: (host) => /(^|\.)glassdoor\./.test(host),
      isJobPage: (doc, url) => /job-listing|[?&]jl=/i.test(url) || Boolean(query(doc, '[data-test="job-title"]')),
      read: (doc) => ({
        role: pick(doc, '[data-test="job-title"]', '[data-test="jobTitle"]', 'h1'),
        company: pick(doc, '[data-test="employer-name"]', '[data-test="employerName"]', '[class*="EmployerProfile_employerName"]')
          .replace(/\s*\d(?:\.\d)?\s*★?$/, ''),
        location: pick(doc, '[data-test="location"]', '[data-test="emp-location"]'),
        salary: pick(doc, '[data-test="detailSalary"]', '[data-test="salaryEstimate"]', '[class*="SalaryEstimate"]'),
        description: pick(doc, '[class*="JobDetails_jobDescription"]', '[class*="jobDescription"]', '#JobDescriptionContainer'),
      }),
    },
    {
      name: 'Greenhouse',
      matches: (host) => hostIs(host, 'greenhouse.io'),
      isJobPage: (doc, url) => /\/jobs\/\d+|[?&](?:gh_jid|token)=\d+/.test(url),
      read: (doc, url) => ({
        role: pick(doc, '.job__title h1', 'h1.app-title', '.app-title', 'h1.section-header', 'h1'),
        company: stripLabel(pick(doc, '.company-name', '.job__company'), 'at')
          || clean((String(doc.title).match(/^job application for .+? at (.+)$/i) || [])[1]),
        companyFallback: safely(() => new URL(url).searchParams.get('for')) || companyFromPath(url).replace(/^Embed$/, ''),
        location: pick(doc, '.job__location', '.location', '#header .location'),
        description: pick(doc, '.job__description', '#content', '.job-post-content', '#app_body'),
      }),
    },
    {
      name: 'Lever',
      matches: (host) => hostIs(host, 'lever.co'),
      isJobPage: (doc, url) => /lever\.co\/[^/]+\/[0-9a-f-]{36}/i.test(url),
      read: (doc, url) => ({
        role: pick(doc, '.posting-headline h2', '.posting-header h2', 'h2'),
        company: pickAttr(doc, '.main-header-logo img', 'alt').replace(/\s*logo$/i, ''),
        companyFallback: companyFromPath(url),
        location: pick(doc, '.posting-categories .location', '.posting-category.location'),
        workMode: pick(doc, '.posting-categories .workplaceTypes', '.workplaceTypes'),
        header: pick(doc, '.posting-categories', '.posting-headline'),
        description: pick(doc, '[data-qa="job-description"]', '.section-wrapper.page-full-width', '.posting-page .content'),
      }),
    },
    {
      name: 'Workday',
      matches: (host) => hostIs(host, 'myworkdayjobs.com') || hostIs(host, 'myworkdaysite.com'),
      isJobPage: (doc, url) => /\/job\//.test(url) || Boolean(query(doc, '[data-automation-id="jobPostingHeader"]')),
      read: (doc, url) => ({
        role: pick(doc, '[data-automation-id="jobPostingHeader"]', 'h1'),
        companyFallback: workdayCompany(url),
        location: stripLabel(pickPlaces(doc, '[data-automation-id="locations"]', '[data-automation-id="location"]'), 'locations?'),
        workMode: stripLabel(pick(doc, '[data-automation-id="remoteType"] dd', '[data-automation-id="remoteType"]'), 'remote type'),
        description: pick(doc, '[data-automation-id="jobPostingDescription"]'),
      }),
    },
    {
      name: 'Ashby',
      matches: (host) => hostIs(host, 'ashbyhq.com'),
      isJobPage: (doc, url) => /ashbyhq\.com\/[^/]+\/[0-9a-f-]{36}/i.test(url),
      read: (doc, url) => ({
        role: pick(doc, '.ashby-job-posting-heading', 'h1[class*="_title_"]', 'h1'),
        companyFallback: companyFromPath(url),
        location: labelValue(doc, ['Location']),
        workMode: labelValue(doc, ['Location Type', 'Workplace Type', 'Remote']),
        description: pick(doc, '.ashby-job-posting-description', '[class*="_descriptionText_"]', '[class*="description"]'),
      }),
    },
  ];

  /** acme.wd5.myworkdayjobs.com → "Acme"; wd5.myworkdaysite.com/recruiting/acme/... → "Acme". */
  function workdayCompany(url) {
    const parsed = safely(() => new URL(url));
    if (!parsed) return '';
    const first = parsed.hostname.split('.')[0];
    if (!/^wd\d+$/i.test(first)) return titleCase(first.replace(/[-_]+/g, ' '));
    const segments = parsed.pathname.split('/').filter(Boolean);
    const i = segments.indexOf('recruiting');
    return i >= 0 && segments[i + 1] ? titleCase(segments[i + 1].replace(/[-_]+/g, ' ')) : '';
  }

  function readerFor(host) {
    return SITE_READERS.find((reader) => reader.matches(host)) || null;
  }

  // ===== Public API ========================================================

  const JOB_PATH_RE = /job|career|position|opening|vacanc|requisition|posting/i;
  const JOB_WORDS = ['responsibilit', 'requirement', 'qualification', 'experience', 'apply'];

  /** Cheap check used to decide whether to show the floating button. */
  function isLikelyJobPage(doc, url) {
    const d = doc || document;
    const href = url || (d.location && d.location.href) || '';
    const reader = readerFor(hostnameOf(href));
    if (reader) return Boolean(safely(() => reader.isJobPage(d, href)));
    if (queryAll(d, 'script[type="application/ld+json"]').some((s) => /JobPosting/.test(s.textContent))) return true;
    if (/[?&]gh_jid=\d+/.test(href)) return true; // Greenhouse embedded on a company site

    // Cheap URL test first; the page text is only read when the URL looks like a job.
    const parsed = safely(() => new URL(href));
    if (!parsed || !JOB_PATH_RE.test(parsed.pathname + parsed.search) || !query(d, 'h1, h2, [role="heading"]')) return false;
    const text = (d.body ? d.body.textContent : '').slice(0, 200000).toLowerCase();
    return JOB_WORDS.filter((w) => text.includes(w)).length >= 2;
  }

  function firstOf(...values) {
    return values.map(clean).find(Boolean) || '';
  }

  /** A Job object (see docs/ARCHITECTURE.md §5) pre-filled from the page. */
  function extractJob(doc, url) {
    const d = doc || document;
    const href = url || (d.location && d.location.href) || '';
    const host = hostnameOf(href);
    const reader = readerFor(host);
    const site = (reader && safely(() => reader.read(d, href))) || {};
    const ld = pickPosting(readJsonLdPostings(d).map(mapPosting), site.role);
    const generic = readGeneric(d, href);

    const description = (firstOf(site.description, ld.description) || genericDescription(d)).slice(0, MAX_DESCRIPTION);
    const location = firstOf(site.location, ld.location, generic.location);
    const siteYoe = site.yoe ? usefulYoe(extractYOE(site.yoe, { requireContext: false })) : '';

    return {
      company: firstOf(site.company, ld.company, site.companyFallback, generic.company).slice(0, MAX_FIELD),
      role: firstOf(site.role, ld.role, generic.role).slice(0, MAX_FIELD),
      appliedDate: today(),
      status: 'Applied',
      workMode: workModeFrom({
        explicit: `${site.workMode || ''} ${ld.workMode || ''}`,
        location,
        header: `${site.header || ''} ${generic.header}`,
        description,
      }),
      location: location.slice(0, MAX_FIELD),
      yoe: firstOf(siteYoe, ld.yoe) || extractYOE(description),
      salary: firstOf(ld.salary, siteSalary(site.salary)) || salaryFromText(description),
      source: sourceFromHost(host),
      url: canonicalUrl(href),
      notes: '',
    };
  }

  return {
    extractJob,
    isLikelyJobPage,
    canonicalUrl,
    extractYOE,
    workModeFrom,
    salaryFromText,
    sourceFromHost,
    readJsonLdPostings,
    SOURCE_NAMES,
  };
});
