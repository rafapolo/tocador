// Who may fetch what: client-IP trust, hotlink allowlist and bot policy.
// Stateless leaves split out of proxy.js; rate limiting and counters stay there.

// §3 — XFF trust boundary: only believe X-Forwarded-For from trusted proxies
const TRUSTED_PROXIES = new Set(
  (process.env.TRUSTED_PROXY_IPS ?? '127.0.0.1,::1').split(',').filter(Boolean)
);
export function realIp(req, server) {
  const sock = server.requestIP(req);
  const remoteIp = sock?.address ?? '0.0.0.0';
  if (!TRUSTED_PROXIES.has(remoteIp)) return remoteIp;
  const xff = req.headers.get('x-forwarded-for');
  if (!xff) return remoteIp;
  return xff.split(',', 1)[0].trim().slice(0, 64) || remoteIp;
}

// §5 — hotlink protection: audio only; images (covers) are explicitly exempt
export const ALLOWED_ORIGINS = new Set([
  'https://rafapolo.github.io',
  'https://cdn.tocador.cc',
  'https://radio.tocador.cc',
  'https://tocador.cc',
  'http://localhost:9001',
]);
// No Referer/Origin at all is refused: every browser sends at least the origin for a
// cross-origin <audio> request (strict-origin-when-cross-origin), so a bare request is
// curl, a download manager or a scraper. Our own server-side checks set one explicitly.
export function refererAllowed(req) {
  const ref = req.headers.get('referer') ?? req.headers.get('origin');
  if (!ref) return false;
  try {
    const u = new URL(ref);
    return ALLOWED_ORIGINS.has(`${u.protocol}//${u.host}`);
  } catch { return false; }
}

// Legitimate crawlers we want to let through — Google indexing + og:image rendering
export const goodBotRegex = /googlebot|googleother|google-inspectiontool|google-extended|adsbot-google|mediapartners-google|google-read-aloud|apis-google/i;

// Link-preview crawlers. Album pages on tocador.cc name a cover here as og:image, and a
// preview bot refused it shows no picture — so these may fetch images, which are public
// anyway (no hotlink check), and nothing else: audio stays off limits to them. They used
// to get covers only by luck, when nginx already held one cached from a browser.
const previewBotRegex = /facebookexternalhit|facebookcatalog|meta-externalagent|twitterbot|linkedinbot|discordbot|pinterestbot|slackbot|telegrambot|whatsapp|redditbot|bluesky|cardyb|mastodon|skypeuripreview|iframely|embedly|applebot/i;
const IMAGE_PATH_RE = /\.(?:jpe?g|png|webp)$/i;

// Whether the proxy turns this user agent away from this path.
export function blockedBot(ua, pathname) {
  if (!botRegex.test(ua) || goodBotRegex.test(ua)) return false;
  return !(previewBotRegex.test(ua) && IMAGE_PATH_RE.test(pathname));
}

const botRegex = new RegExp([
  // automation & headless browsers
  'scrapy', 'selenium(?:-webdriver)?', 'puppeteer', 'playwright', 'phantomjs', 'casperjs',
  'headless\\s*(?:chrome|browser)?', 'headlesschrome',
  'automation\\s*tool', 'automated\\s*browser', 'bot\\s*automation',
  'httpclient', 'http\\s*client', 'axios\\/\\d+', 'node-fetch', 'got\\/\\d+',
  'mechanize', 'urllib', 'requests\\/\\d+', 'okhttp', 'retrofit', 'wget\\/', 'httrack', 'aria2', 'lftp', 'webcopy',
  'web\\s*scraper', 'data\\s*scraper', 'content\\s*scraper',
  'mass\\s*(?:crawl|scrape|download)', 'bulk\\s*(?:crawl|download|fetch)',
  'site\\s*crawler', 'link\\s*crawler',
  'botkit', 'dialogflow', 'rasa', 'botpress',
  'datacenter\\s*proxy', 'residential\\s*proxy', 'rotating\\s*proxy', 'proxy\\s*(?:rotation|pool)',
  'tor\\s*exit', 'tor\\s+network',
  'jsdom', 'cheerio', 'python-requests', 'python\\s*urllib', 'aiohttp', 'go-http-client', 'java\\/\\d+\\.\\d+',
  'aws\\s*lambda', 'google\\s*cloud\\s*functions', 'azure\\s*functions',
  'bot\\s*engine', 'crawler\\s*engine', 'spider\\s*engine',
  'auto\\s*fetch', 'auto\\s*scrape', 'auto\\s*crawl',
  // search engines (Google crawlers intentionally absent — we want sitemap indexing;
  // goodBotRegex still exempts them from the generic 'bot' catch-all below)
  'bingbot', 'msnbot', 'adidxbot', 'bingpreview',
  'slurp', 'duckduckbot', 'baiduspider', 'yandexbot', 'sogou', 'exabot',
  'applebot', 'petalbot', 'bytespider', 'seznambot', 'qwantify', 'mojeek', 'neevabot',
  '360spider', 'haosouspider', 'sosospider',
  // archive
  'ia_archiver', 'archive\\.org_bot',
  // social media crawlers
  'facebookexternalhit', 'facebookcatalog',
  'twitterbot', 'linkedinbot', 'discordbot', 'pinterestbot', 'slackbot', 'telegrambot', 'whatsapp',
  // SEO / analytics tools
  'semrushbot', 'ahrefsbot', 'mj12bot', 'dotbot', 'rogerbot',
  'screaming\\s*frog', 'sistrix', 'serpstat', 'similarweb', 'netcraft', 'dataforseo', 'netsystemsresearch',
  // AI / LLM crawlers
  'gptbot', 'chatgpt-user', 'openai-searchbot', 'claudebot', 'claude-web', 'anthropic-ai', 'cohere-ai', 'ccbot', 'amazonbot', 'diffbot',
  // security scanners
  'censys', 'shodan', 'masscan', 'zgrab', 'nuclei', 'nikto', 'sqlmap', 'wfuzz', 'dirbuster', 'gobuster', 'ffuf', 'nmap\\s*scripting',
  'openvas', 'qualys', 'tenable', 'acunetix', 'burpsuite', 'zap(?:\\s*proxy)?',
  // feed readers
  'feedfetcher', 'feedly', 'inoreader', 'newsblur',
  // generic catch-all
  'bot', 'crawler', 'spider',
].join('|'), 'i');
