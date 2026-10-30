# Atlas

[tocador.cc/atlas](https://tocador.cc/atlas) mostra **todas as faixas** dos acervos UQT e Hominis
Canidae (~79 mil) como pontos num mapa. Faixas que soam parecido ficam perto. Dá para aproximar,
arrastar, girar em 3D (botão direito do mouse no desktop; no celular, ligue o ⟳ e arraste com um dedo) e clicar numa faixa para ouvir no player.

![prévia](assets/atlas-og.jpg)

## Como ler o mapa

- **Cada ponto é uma faixa.** A cor é o macro-gênero mais provável segundo o classificador (Rock,
  Latino, Eletrônica, Folk/World, Hip Hop, Jazz, Pop, Funk/Soul, Outros).
- **Os rótulos** (Samba, Punk, Cloud Rap…) ficam na mediana dos pontos de cada subgênero. Só aparecem
  os subgêneros que formam um "lugar", isto é, que não estão espalhados pelo mapa inteiro.
- **De perto**, a partir de ~10× de zoom, cada ponto ganha o título da faixa.
- **Os eixos não significam nada.** Não existe "mais para a direita = mais rápido". O [UMAP](https://umap-learn.readthedocs.io/) só preserva
  vizinhança: o que está perto é parecido, mas a distância entre regiões longe uma da outra não é uma
  medida confiável (Samba longe de Punk quer dizer "diferentes", não "x vezes mais diferentes").
- **Dois mapas** (botão Som / Gêneros):
  - **Som**: a posição vem do áudio. Mostra o que *soa* parecido, independente do rótulo.
  - **Gêneros**: a posição vem só dos rótulos de gênero previstos. Mostra o que o *classificador acha*
    parecido; os grupos são mais limpos, mas repetem os rótulos.

O que se vê no mapa "Som", de frente:
- **Rock**: ocupa o oeste, com Punk e Hardcore numa ponta e Indie e Alternative mais ao centro.
- **Latino**: ocupa o leste, num bloco denso de Samba, MPB, Batucada e Bossa Nova (quase todo o acervo UQT).
- **Folk e Jazz**: fazem a ponte entre os dois. Neofolk encosta no Rock, Bossa Nova encosta no Jazz.
- **Hip Hop**: forma uma península ao sul (Cloud Rap, Trap, Gangsta), ligada à Eletrônica.
- **Eletrônica**: dividida em duas regiões: Experimental/Ambient ao norte, House/Downtempo/Synth-pop ao sudoeste.

## Por que aparecem linhas (fios de pontos)

Ao aproximar, alguns trechos não são nuvens: são **fios**, filas de pontos quase em linha (como o fio de
noise/power electronics e o fio de gravações de rádio antigas). Isso foi medido nos dois fios dos
prints que motivaram esta seção:

| Fio | Pontos / álbuns | Variância no 1º eixo | O que muda ao longo do fio |
|---|---|---|---|
| Noise / Power Electronics / Industrial (homi, 2013–2023) | 265 faixas, 118 álbuns | 57% | **loudness** (r = −0,63) |
| Rádio antiga e 78 rpm reeditados ("Almanaque da Rádio Nacional", "Noel pela primeira vez"…) | 369 faixas, 62 álbuns | 58% | **dinâmica** (r = −0,55) |

O que isso quer dizer:

1. **Não é um álbum isolado.** Cada fio junta dezenas de álbuns de artistas diferentes.
2. **Não é uma mistura de dois rótulos.** A proporção entre os dois gêneros mais prováveis quase não
   acompanha a posição no fio (|r| ≤ 0,22), e o ano também não (|r| ≤ 0,23).
3. **É um grupo com uma assinatura sonora muito forte que varia quase só numa direção.**
   - O ruído saturado e o som de gravação antiga (mono, banda estreita, chiado) dominam o embedding.
     Todas essas faixas ficam parecidas entre si e diferentes do resto.
   - O que sobra de variação dentro do grupo é quase unidimensional: mais alto ou mais baixo, mais ou
     menos dinâmico.
   - Os vizinhos mais próximos de cada faixa formam então uma corrente (A perto de B, B perto de C…).
   - O UMAP preserva exatamente essa vizinhança local, e a corrente vira um fio. Com `min_dist` baixo
     (0,08), os fios ficam finos.
4. **No 3D**, girando, muitos fios se revelam tubos ou curvas, que de frente pareciam retas.

Um efeito colateral visível: o classificador de gênero rotula boa parte das gravações dos anos 1930–50
como *Bollywood*, *Dixieland*, *Ragtime* ou *Tango*. Ele reconhece a **sonoridade da época**, não o
gênero, e por isso o fio do rádio aparece com cores misturadas.

## Como foi feito

```
MP3 dos acervos (S3)
  └─ analyze-tracks.py (Essentia + TensorFlow, trecho central de 45 s por faixa)
       ├─ embedding EffNet-Discogs, 1280 dimensões ── "som"
       ├─ top-5 gêneros Discogs-400 (+ BPM, tom, humor, instrumentos…)
       └─ data/features/<acervo>.json.gz + .emb.f16
  └─ script/build-atlas-coords.py
       ├─ som:     normalização L2 → PCA 64 → UMAP cosseno (30 vizinhos, min_dist 0,08)
       ├─ rotulos: scores dos 5 gêneros, matriz esparsa L2 → SVD 50 → UMAP cosseno
       └─ cada um em 2D e depois em 3D, partindo do 2D (init = x, y do 2D + z ~ 0)
          → data/features/atlas-coords.json.gz
  └─ script/build-atlas-web.js
       ├─ casa cada faixa analisada com o catálogo publicado (aliases incluídos)
       ├─ quantiza x, y, z em Uint16 (mesma escala nos três eixos)
       ├─ guarda um hash de 32 bits da chave "<álbum>/<arquivo>" por ponto
       └─ calcula os rótulos (mediana de cada subgênero) → data/atlas-faixas.json.gz (~1,4 MB)
  └─ atlas.html + js/atlas.js (WebGL)
```

Decisões que importam:

- **O 3D parte do 2D.** O UMAP 3D recebe as posições do 2D como ponto de partida, então visto de frente
  o mapa continua reconhecível, e girar acrescenta profundidade em vez de embaralhar tudo.
- **Pontos casados por hash, não por ordem.** A página baixa o catálogo e procura cada faixa pelo hash
  da chave. Um ETL que acrescente ou reordene álbuns (a conversão v2 ordena por artista) não quebra o
  mapa: faixas novas ficam sem ponto até a próxima geração.
- **Desenho.**
  - Todos os pontos vão numa única chamada `gl.POINTS`, com a cor por gênero e o filtro (busca, gênero,
    acervo) num atributo.
  - A troca Som ↔ Gêneros é um `mix()` no shader entre as duas posições.
  - No 3D, a rotação é ortográfica em torno do ponto no centro da tela, com tamanho e brilho como pista
    de profundidade.
- **Clique.** Na vista plana, uma grade 256×256 acha o ponto mais perto. Girado, projeta todos os
  pontos (~1 ms).
- **Ir para o player.** O link reproduz a numeração de faixas do player (deduplicação por título,
  `num ?? posição`) e abre a página do álbum no tocador.cc (`/<acervo>/<slug>/?play=1#tN`).

## Limitações

- **75 faixas do UQT não têm ponto.** 74 são MP3 de 0 byte já no backup de origem, e uma tem ~1 s
  (`tasks/uqt-faixas-vazias.md`, só local).
- **O UMAP não é incremental.** Rodar de novo após um ETL redesenha o mapa inteiro, e as regiões podem
  mudar de lugar.
- **Gênero é previsão de modelo, não metadado.** Ele erra de forma sistemática, como no caso das
  gravações antigas.
- **O mapa reflete um trecho de 45 s** do meio de cada faixa, não a faixa inteira.

## Regenerar (depois de um ETL)

```bash
uv run -q --with umap-learn --with scikit-learn --with scipy --with numpy \
  python script/build-atlas-coords.py          # ~25 min sem --reuse-* (2D + 3D dos dois mapas)
bun script/build-atlas-web.js                  # payload + relatório de cobertura
uv run -q --with matplotlib --with numpy --with pillow python script/build-atlas-og.py
```

Testes: `npx playwright test tests/atlas.spec.js` (fixtures em `tests/fixtures/build-atlas-fixture.js`).
