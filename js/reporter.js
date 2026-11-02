// Reporter de erros comum a todas as páginas (player, rádio, /atlas, 3D) — manda para tocador/issues
// via o proxy (POST cdn.tocador.cc/report-error), que deduplica por título: um título igual vira
// comentário na issue aberta. Por isso os títulos devem ser estáveis (sem ids, horários, URLs longas).
//
// Classic script, carregado antes dos outros da página. Expõe:
//   reportar(categoria, titulo, detalhe, { markdown })   categoria: js | catalogo | features | reproducao | atlas
//   trackedFetch(url, opts)                              fetch que lembra a última URL (vai no contexto)
// <script src="js/reporter.js" data-pagina="radio"> põe "[radio]" no título; o padrão é "[tocador]".
//
// O objetivo é registrar o evento para pensar no conserto depois, não corrigir nada aqui.
(function () {
  const REPORT_URL = 'https://cdn.tocador.cc/report-error';
  const PAGINA = document.currentScript?.dataset.pagina || 'tocador';
  const ua = navigator.userAgent;
  // Real Chrome/Chromium patch numbers have never exceeded ~300; a randomized-UA bot generator
  // flooded /radio with spoofed UAs like "Chrome/56.0.4817.1447" (#546-#568). navigator.webdriver
  // catches automation frameworks, whose headless engines lack a real media backend.
  const FAKE_CHROME = /Chrome\/\d+\.\d+\.\d+\.\d{4,}/.test(ua);
  const IS_BOT = navigator.webdriver || FAKE_CHROME ||
    /bot|crawl|spider|headless|googleother|google-extended|read-aloud|inspectiontool|apis-google/i.test(ua);
  // Teto por categoria e por carregamento de página: uma sessão que percorre o catálogo inteiro
  // (#578-637: 60 issues, 43 de uma sessão em 66 min) não abre uma issue por faixa.
  const MAX_POR_CATEGORIA = 3;
  const vistos = new Set();
  const porCategoria = {};

  function contexto() {
    const conn = navigator.connection;
    return [
      `**URL:** ${location.href}`,
      `**UA:** ${ua}`,
      `**online:** ${navigator.onLine}`,
      conn ? `**connection:** ${[conn.effectiveType, conn.downlink && conn.downlink + 'Mbps'].filter(Boolean).join(' ')}` : null,
      `**viewport:** ${innerWidth}×${innerHeight} @${devicePixelRatio}x`,
      window.__lastFetchUrl ? `**last fetch:** ${window.__lastFetchUrl}` : null,
      `**sw:** ${navigator.serviceWorker?.controller ? 'ativo' : 'não'}`,
      `**Time:** ${new Date().toISOString()}`,
    ].filter(Boolean).join('\n');
  }

  function reportar(categoria, titulo, detalhe = '', opts = {}) {
    const title = `[${PAGINA}] ${titulo}`.slice(0, 200);
    porCategoria[categoria] ??= 0;
    if (IS_BOT || porCategoria[categoria] >= MAX_POR_CATEGORIA || vistos.has(title)) return false;
    vistos.add(title);
    porCategoria[categoria]++;
    const corpo = opts.markdown ? String(detalhe) : ['```', String(detalhe).slice(0, 4000), '```'].join('\n');
    const body = [`**${title}**`, '', corpo, '', contexto()].join('\n').slice(0, 7500);
    window.__reportes = (window.__reportes || []).concat({ categoria, title });   // para os testes
    fetch(REPORT_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, body, categoria }), keepalive: true, credentials: 'omit',
    }).catch(() => {});
    return true;
  }

  function descreverErro(err) {
    if (err == null) return String(err);
    if (err instanceof Error) return err.stack && err.stack.includes(err.message) ? err.stack : `${err.name}: ${err.message}\n${err.stack || ''}`;
    if (typeof Response !== 'undefined' && err instanceof Response) return `Response ${err.status} ${err.url}`;
    try { return `${typeof err}: ${JSON.stringify(err)}`; } catch { return String(err); }
  }

  window.addEventListener('error', e => {
    // Recurso que não carregou (<script>, <img>, <link>): chega aqui só com captura, ignorado.
    if (!(e instanceof ErrorEvent)) return;
    const msg = e.message || String(e);
    if (msg.includes('ResizeObserver')) return; // browser noise, not actionable
    // Cross-origin scripts (loaded without CORS) report as bare "Script error." with no
    // filename/lineno — that's third-party code (analytics, extensions), not ours.
    if (msg === 'Script error.' && !e.filename) return;
    if (e.filename && /umami|^(chrome|moz|safari(-web)?)-extension:/i.test(e.filename)) return;
    const arquivo = e.filename ? e.filename.replace(/^https?:\/\/[^/]+\//, '').replace(/\?.*/, '') : '';
    const loc = arquivo ? ` @ ${arquivo}:${e.lineno}` : '';
    reportar('js', `JS error: ${msg}${loc}`, e.error?.stack || msg);
  });

  window.addEventListener('unhandledrejection', e => {
    const reason = e.reason;
    if (reason?.name === 'NotAllowedError' || reason?.name === 'AbortError') { e.preventDefault(); return; }
    const msg = reason?.message || (reason instanceof Response ? `HTTP ${reason.status}` : String(reason));
    if (/failed to fetch|network error|load failed|networkerror/i.test(msg)) { e.preventDefault(); return; }
    // #640 chegou como "Unhandled rejection: 404", sem dizer de onde: a pilha sintética e a
    // última URL buscada vão no corpo.
    const pilha = reason instanceof Error ? descreverErro(reason) : `${descreverErro(reason)}\n\n(sem pilha própria)\n${new Error().stack || ''}`;
    reportar('js', `Unhandled rejection: ${msg}`, pilha);
  });

  window.reportar = reportar;
  window.descreverErro = descreverErro;
  window.trackedFetch = function trackedFetch(url, opts) {
    window.__lastFetchUrl = url;
    return fetch(url, opts);
  };
})();
