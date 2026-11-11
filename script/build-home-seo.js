#!/usr/bin/env node
// Home SEO/GEO, gerado no deploy (deploy.yml, depois de build-album-pages.js):
//   1. preenche o texto citável ("O Tocador é…") entre <!--HOME-SEO:TEXTO--> e
//      <!--/HOME-SEO:TEXTO--> no index.html;
//   2. preenche o JSON-LD (WebSite, Organization, DataCatalog) entre
//      <!--HOME-SEO:LD--> e <!--/HOME-SEO:LD-->;
//   3. escreve llms.txt na raiz.
// Os números (álbuns, faixas, artistas, anos) saem do catálogo real quando o deploy passa --catalog alias=arquivo, e de data/resumo-acervo.json como reserva; nunca são escritos à mão. O resumo envelhece.
// são escritos à mão. Os marcadores ficam vazios no index.html versionado: assim as
// páginas de álbum (playerTemplate) e os espelhos uqt/homi não herdam texto nem
// JSON-LD da home, e o script é idempotente (pode rodar de novo sobre o resultado).
//
//   node script/build-home-seo.js [--root .] [--html index.html] [--llms llms.txt]
//
// O bloco de texto é .sr-only: fica no corpo do HTML (crawlers sem JS e leitores de
// tela o leem), mas não ocupa lugar na página, então não duplica o cabeçalho do app
// nem mexe no CLS. Os links são absolutos (https://tocador.cc/...) porque o mesmo
// index.html é servido de subpasta nos espelhos, onde "uqt/" apontaria para um 404.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SITE = 'https://tocador.cc';

const milhar = n => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');

// Conta o catálogo que o deploy acabou de baixar. O resumo é gerado à mão e envelhece
// (em 2026-11 dizia 2.159 álbuns no uqt contra 2.450 reais); o catálogo não.
// Artistas = nomes distintos de artista de álbum, sem os vazios (compilações sem artista).
function contarCatalogo(file) {
  require('../js/acervo-format.js');
  let raw = fs.readFileSync(file);
  if (raw[0] === 0x1f && raw[1] === 0x8b) raw = zlib.gunzipSync(raw);
  const db = globalThis.decodeAcervo(JSON.parse(raw.toString('utf8')));
  const anos = db.albums.map(a => a.year).filter(y => y > 0);
  return {
    albuns: db.albums.length,
    faixas: db.albums.reduce((n, a) => n + a.tracks.length, 0),
    artistas: new Set(db.albums.map(a => a.artist).filter(Boolean)).size,
    anoMin: Math.min(...anos), anoMax: Math.max(...anos),
    horas: Number(db.meta && db.meta.hours),
  };
}

function numeros(resumo, catalogos = {}) {
  const out = {};
  for (const alias of ['uqt', 'homi']) {
    const a = resumo.acervos && resumo.acervos[alias];
    if (!a || !a.catalogo || !a.meta) throw new Error(`resumo-acervo.json sem o acervo ${alias}`);
    const c = a.catalogo;
    out[alias] = {
      albuns: c.albuns, faixas: c.faixas, artistas: c.artistas,
      anoMin: c.ano_min, anoMax: c.ano_max, horas: Number(a.meta.hours),
    };
    if (catalogos[alias]) {
      const c = contarCatalogo(catalogos[alias]);
      if (!(c.horas > 0)) delete c.horas; // catálogo sem meta.hours: fica o do resumo
      Object.assign(out[alias], c);
    }
    for (const k of ['albuns', 'faixas', 'artistas', 'anoMin', 'anoMax', 'horas']) {
      if (!Number.isFinite(out[alias][k]) || out[alias][k] <= 0) throw new Error(`resumo-acervo.json: ${alias}.${k} inválido`);
    }
  }
  return out;
}

function textoHtml(n) {
  const { uqt, homi } = n;
  return `<section class="sr-only" id="sobre-tocador" aria-labelledby="sobre-tocador-titulo">
<h2 id="sobre-tocador-titulo">O que é o Tocador</h2>
<p>O Tocador é um player gratuito de acervos musicais que roda direto no navegador, sem cadastro nem instalação: basta apontar para um catálogo e a música toca. Hoje ele reúne dois acervos independentes.</p>
<p>O <a href="${SITE}/uqt/">Acervo UQT</a> reúne 100 anos de MPB: ${milhar(uqt.albuns)} álbuns de ${milhar(uqt.artistas)} artistas, de ${uqt.anoMin} a ${uqt.anoMax}, do samba de raiz ao pagode, com cerca de ${milhar(uqt.horas)} horas de música. O <a href="${SITE}/homi/">Hominis Canidae</a> reúne música independente brasileira desde 2009: ${milhar(homi.albuns)} álbuns de ${milhar(homi.artistas)} artistas, de ${homi.anoMin} a ${homi.anoMax}, com cerca de ${milhar(homi.horas)} horas.</p>
<p>Cada álbum tem página própria, com lista de faixas, e o acervo pode ser filtrado por artista, gênero, década ou pela pegada do som (andamento, dançabilidade, clima), medida por análise de áudio. Há ainda o <a href="${SITE}/atlas">Atlas</a>, um mapa de todas as faixas organizado pela semelhança do som, a <a href="${SITE}/radio">Rádio</a> e a <a href="${SITE}/3d">galeria 3D</a> de capas.</p>
</section>`;
}

function jsonLd(n) {
  const { uqt, homi } = n;
  const acervo = (alias, nome, desc, x) => ({
    '@type': 'Dataset',
    '@id': `${SITE}/${alias}/#acervo`,
    name: nome,
    description: `${desc}: ${milhar(x.albuns)} álbuns, ${milhar(x.faixas)} faixas e ${milhar(x.artistas)} artistas, de ${x.anoMin} a ${x.anoMax}.`,
    url: `${SITE}/${alias}/`,
    inLanguage: 'pt-BR',
    temporalCoverage: `${x.anoMin}/${x.anoMax}`,
    isPartOf: { '@id': `${SITE}/#catalogo` },
  });
  const grafo = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebSite',
        '@id': `${SITE}/#site`,
        name: 'Tocador',
        url: `${SITE}/`,
        inLanguage: 'pt-BR',
        publisher: { '@id': `${SITE}/#organizacao` },
        // ?q= é lido por getQueryFromUrl() em js/url-meta.js; ?acervo= escolhe o acervo.
        potentialAction: {
          '@type': 'SearchAction',
          target: { '@type': 'EntryPoint', urlTemplate: `${SITE}/?acervo=uqt&q={search_term_string}` },
          'query-input': 'required name=search_term_string',
        },
      },
      {
        '@type': 'Organization',
        '@id': `${SITE}/#organizacao`,
        name: 'Tocador',
        url: `${SITE}/`,
        logo: `${SITE}/assets/capa.jpg`,
      },
      {
        '@type': 'DataCatalog',
        '@id': `${SITE}/#catalogo`,
        name: 'Acervos do Tocador',
        description: 'Dois acervos de música brasileira para ouvir no navegador: Acervo UQT (100 anos de MPB) e Hominis Canidae (música independente desde 2009).',
        url: `${SITE}/`,
        inLanguage: 'pt-BR',
        dataset: [
          acervo('uqt', 'Acervo UQT', '100 anos de MPB', uqt),
          acervo('homi', 'Hominis Canidae', 'Música independente brasileira desde 2009', homi),
        ],
      },
    ],
  };
  // "<" escapado para que nada dentro do JSON feche o <script>
  return `<script type="application/ld+json">\n${JSON.stringify(grafo, null, 2).replace(/</g, '\\u003c')}\n</script>`;
}

function llmsTxt(n) {
  const { uqt, homi } = n;
  return `# Tocador

> Player gratuito de acervos musicais brasileiros, no navegador: o Acervo UQT (100 anos de MPB, ${milhar(uqt.albuns)} álbuns) e o Hominis Canidae (música independente desde 2009, ${milhar(homi.albuns)} álbuns).

## Acervos

- [Acervo UQT](${SITE}/uqt/): índice de todos os álbuns, de ${uqt.anoMin} a ${uqt.anoMax}.
- [Hominis Canidae](${SITE}/homi/): índice de todos os álbuns, de ${homi.anoMin} a ${homi.anoMax}.

## Ferramentas

- [Atlas](${SITE}/atlas): mapa de todas as faixas pela semelhança do som.
- [Rádio](${SITE}/radio): reprodução contínua.
- [Galeria 3D](${SITE}/3d): capas dos álbuns em 3D.

## Sitemaps

- ${SITE}/sitemap.xml
- ${SITE}/sitemap-albums-uqt.xml
- ${SITE}/sitemap-albums-homi.xml
`;
}

function preencher(html, nome, conteudo) {
  const re = new RegExp(`(<!--HOME-SEO:${nome}-->)[\\s\\S]*?(<!--/HOME-SEO:${nome}-->)`);
  if (!re.test(html)) throw new Error(`index.html sem os marcadores HOME-SEO:${nome}`);
  return html.replace(re, (_, a, b) => `${a}\n${conteudo}\n${b}`);
}

function gerar(html, resumo, catalogos = {}) {
  const n = numeros(resumo, catalogos);
  html = preencher(html, 'LD', jsonLd(n));
  html = preencher(html, 'TEXTO', textoHtml(n));
  return { html, llms: llmsTxt(n) };
}

module.exports = { gerar, numeros, contarCatalogo, textoHtml, jsonLd, llmsTxt };

if (require.main === module) {
  const args = process.argv.slice(2);
  const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
  const root = path.resolve(opt('--root', path.join(__dirname, '..')));
  const htmlPath = path.resolve(root, opt('--html', 'index.html'));
  const llmsPath = path.resolve(root, opt('--llms', 'llms.txt'));
  const resumo = JSON.parse(fs.readFileSync(path.join(root, 'data', 'resumo-acervo.json'), 'utf8'));
  // --catalog uqt=<arquivo> (repetível): números do catálogo real em vez dos do resumo.
  const catalogos = {};
  args.forEach((a, i) => {
    if (a !== '--catalog') return;
    const [alias, ...resto] = String(args[i + 1] || '').split('=');
    if (!resto.length) throw new Error('--catalog espera alias=arquivo');
    catalogos[alias] = path.resolve(resto.join('='));
  });
  const { html, llms } = gerar(fs.readFileSync(htmlPath, 'utf8'), resumo, catalogos);
  fs.writeFileSync(htmlPath, html);
  fs.writeFileSync(llmsPath, llms);
  console.log(`home-seo: ${path.relative(process.cwd(), htmlPath)} e ${path.relative(process.cwd(), llmsPath)} escritos`);
}
