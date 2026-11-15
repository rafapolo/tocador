// A barra do player tem de ocupar a largura toda em qualquer tela. Em 2026-11-13 o .player-bar virou um flex em
// coluna no mobile, e o `margin: 0 auto` do .player-content anulou o stretch: a linha de controles encolheu para o
// tamanho do conteúdo, a barra de progresso virou um ponto e os botões ⤮ e ☰ (absolutos) caíram sobre ⏮ e ⏭.
// Nenhum teste olhava geometria, só se os botões funcionavam. Aqui se mede o que se vê.
const { test, expect } = require('@playwright/test');
const { gotoWithFixture } = require('./helpers');

const TELAS = [
  { nome: 'iPhone SE', width: 320, height: 568 },
  { nome: 'iPhone 13', width: 390, height: 844 },
  { nome: 'Android grande', width: 430, height: 932 },
  { nome: 'limite do mobile', width: 768, height: 1024 },
  { nome: 'notebook', width: 1280, height: 800 },
  { nome: 'desktop', width: 1920, height: 1080 },
];

// Retângulos de tudo o que importa na barra, já filtrando o que não está à mostra.
const medir = page => page.evaluate(() => {
  const ret = el => { const r = el.getBoundingClientRect(); return { x: r.left, right: r.right, y: r.top, bottom: r.bottom, w: r.width, h: r.height }; };
  const visivel = el => { const s = getComputedStyle(el); const r = el.getBoundingClientRect(); return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0; };
  const barra = document.querySelector('.player-bar');
  const cs = getComputedStyle(barra);
  const botoes = [...barra.querySelectorAll('.controls-buttons > button')].filter(visivel)
    .map(b => ({ id: b.id, ...ret(b), svgs: [...b.querySelectorAll('svg')].filter(visivel).map(s => ({ w: s.getBoundingClientRect().width, attr: +s.getAttribute('width') })) }));
  return {
    vw: document.documentElement.clientWidth,
    barra: ret(barra),
    interno: barra.getBoundingClientRect().width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight),
    conteudo: ret(document.querySelector('.player-bar > .player-content')),
    progresso: ret(document.getElementById('main-progress-bar')),
    tempos: ['time-current', 'time-duration'].map(id => ret(document.getElementById(id))),
    botoes,
    largos: [...barra.querySelectorAll('*')].filter(visivel).filter(e => e.getBoundingClientRect().right > document.documentElement.clientWidth + 1).map(e => e.id || e.className),
  };
});

const sobrepoe = (a, b) => a.x < b.right - 1 && b.x < a.right - 1 && a.y < b.bottom - 1 && b.y < a.bottom - 1;

function conferir(m, mobile) {
  // a linha de conteúdo ocupa a largura útil da barra (no desktop até o max-width de 1600)
  expect(m.conteudo.w).toBeGreaterThanOrEqual(Math.min(m.interno, 1600) - 1);
  // a barra de progresso é uma barra de verdade, não um ponto
  expect(m.progresso.w).toBeGreaterThan(mobile ? m.vw * 0.45 : 200);
  expect(m.tempos[0].right).toBeLessThanOrEqual(m.progresso.x + 1);
  expect(m.progresso.right).toBeLessThanOrEqual(m.tempos[1].x + 1);
  // nenhum botão em cima de outro, e nenhum ícone espremido
  for (let i = 0; i < m.botoes.length; i++) {
    for (let j = i + 1; j < m.botoes.length; j++) {
      expect(sobrepoe(m.botoes[i], m.botoes[j]), `${m.botoes[i].id} sobre ${m.botoes[j].id}`).toBe(false);
    }
    for (const s of m.botoes[i].svgs) expect(s.w, `ícone de ${m.botoes[i].id}`).toBeGreaterThanOrEqual(s.attr - 0.5);
  }
  if (mobile) {
    const ids = m.botoes.map(b => b.id);
    for (const id of ['btn-shuffle-mobile', 'btn-prev', 'btn-play', 'btn-next', 'btn-tracklist']) expect(ids).toContain(id);
  }
  // nada da barra sai da tela
  expect(m.largos).toEqual([]);
}

for (const tela of TELAS) {
  const mobile = tela.width <= 768;
  test(`a barra do player ocupa a largura e nada se sobrepõe: ${tela.nome} (${tela.width}px)`, async ({ page }) => {
    await page.setViewportSize({ width: tela.width, height: tela.height });
    await gotoWithFixture(page);
    conferir(await medir(page), mobile);               // antes de escolher um álbum

    await page.locator('.album-item').first().click();
    await expect(page.locator('#player-title')).not.toBeEmpty();
    if (mobile) await expect(page.locator('#mobile-track-drawer')).toHaveClass(/open/);
    conferir(await medir(page), mobile);               // com um álbum na barra (no mobile, a gaveta aberta encolhe a barra, não os controles)

    if (mobile) {                                      // e com a gaveta fechada de novo
      await page.click('#btn-tracklist');
      await expect(page.locator('#mobile-track-drawer')).not.toHaveClass(/open/);
      conferir(await medir(page), mobile);
    }
  });
}
