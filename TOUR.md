# Tour do Atlas: o roteiro

O tour é uma viagem de 1 minuto pelo [/atlas](https://tocador.cc/atlas) que mostra como ler o mapa e como ele vira
música. Um ponteiro desenhado clica nos controles de verdade, então o tour também ensina a usar a página. Para
assistir, use o botão **▶ Tour** na barra de cima (ou a tecla **T**), ou abra `?tour=1`, que começa sozinho quando o
mapa termina de carregar. Acrescente `&t=<segundos>` (por exemplo `?tour=1&t=49` para o grafo) para começar perto
dali: as cenas anteriores passam de uma vez, sem animação. Quando o tour começa, `tour` e `t` saem do endereço, então
recarregar a página abre o mapa e não o filme. **Esc** ou **✕ esc** encerram o tour e devolvem tudo como estava:
mapa, acervo, filtros da legenda, busca, grafo, faixa selecionada e câmera.

Este arquivo descreve o que acontece em cada cena. Para mudar algo, edite aqui e peça a mudança no código: as cenas
ficam em `cenas()`, em `js/atlas-tour.js`. A música é a sonificação do mapa, descrita em [ATLAS.md](ATLAS.md#música-generativa).

## Regras gerais

- **Moldura.** Uma barra preta embaixo, com uma linha dourada de progresso na borda (em cima, o degradê da barra do mapa já faz o papel). A
  interface some, menos o controle que a cena está ensinando, que ganha um contorno dourado.
- **Texto.** Em português. A legenda tem duas partes: um rótulo pequeno em cima (o *kicker*, em geral "tema ·
  lugar") e a frase. Fica no meio da tela, logo acima da barra de baixo.
- **Números e lugares.** Contados no navegador a partir do payload do mapa (`data/atlas-faixas.json.gz`); nenhum
  nome de gênero, artista ou número está escrito no código. Se o mapa for regenerado, o tour escolhe outros lugares
  sozinho.
- **Ponteiro.** Só em telas largas (acima de 980 px). Em telas estreitas o tour clica sem desenhar o ponteiro, mas
  espera o tempo que o clique levaria, então dura o mesmo.
- **Interação.** Uma camada transparente cobre o mapa enquanto o tour roda: arrastar e rolar não mexem na câmera,
  e as teclas do mapa ficam paradas, menos **Esc** (encerra) e **M** (liga ou desliga o som).
- **Histórico.** O tour não escreve no endereço nem cria entradas no histórico. O endereço de antes é o que o
  encerramento usa para devolver o estado.
- **Movimento reduzido.** Com `prefers-reduced-motion`, a câmera corta de um lugar para outro em vez de voar, e o
  giro em 3D fica de fora.

## Som

A trilha do tour é a própria sonificação do mapa: o que a câmera vê vira a partitura, e cada gênero na tela toca uma
parte da banda. Por isso a música muda a cada voo: o samba do lugar mais povoado, o rock do outro lado, uma
raridade de perto, a mistura de uma fusão, a troca Som ↔ Gêneros e
os artistas do grafo.

- Se o **Sonificar** estiver desligado, o tour o liga no clique em ▶ Tour (o clique é o gesto que o navegador exige
  para soar) e o desliga de novo ao terminar. A escolha guardada para a próxima visita volta a ser a de antes.
- Um tour aberto por `?tour=1` começa sem gesto: o navegador só deixa soar depois do primeiro clique ou tecla, e o
  botão ♪ fica âmbar até lá.
- Se o navegador não tiver Web Audio, a cena do Sonificar avisa e o tour segue em silêncio.

## Cenas

Duração total: 60 s. A câmera nunca fica parada mais de 8 s no mesmo lugar: se nada a mexeu por 1,5 s (uma espera
da cena, uma legenda sendo lida), ela desliza devagar, um pouco ao lado e um pouco mais perto, até o próximo voo
(`derivar()`; fora do grafo, que tem o próprio movimento, e sem a deriva com movimento reduzido).

| # | tempo | câmera | o que acontece | kicker · frase |
|---|---|---|---|---|
| 0 | 0–5 s | o mapa inteiro, aproximando devagar | nada se clica | **atlas** · *N faixas (X do UQT, Y do Hominis Canidae). Cada ponto é uma faixa; o que soa parecido fica perto.* |
| 1 | 5–10 s | deriva devagar | o ponteiro vai até **Sonificar** (já ligado desde o clique em ▶ Tour) | **sonificar** · *Nenhum som aqui é gravado: o que a câmera vê vira a partitura, e cada gênero na tela toca uma parte da banda.* |
| 2 | 10–25 s | travessia: do lugar grande (≥1000 faixas) do macro-gênero do mainstream mais longe do outro lado até o lugar grande de outro macro-gênero mais longe do mainstream, parando em até 4 lugares (≥400 faixas) no caminho, em ordem (hoje Batucada → Samba → African → Folk → Indie Rock → Punk) | a legenda narra cada parada (o mainstream ganha sua frase, a troca de macro-gênero é dita) e a banda, fusão do que está à vista, muda aos poucos | **de Batucada a Punk** · *Batucada: N faixas de Latino. Daqui até Punk…* → … → *Punk, N faixas de Rock: o outro lado. Batucada → … → Punk.* |
| 3 | 25–33 s | voa bem perto (até 40×, o zoom em que o rótulo aparece) de dois marcos pequenos | de perto, a banda é só a da raridade | **raridade · …** · *Só N faixas de …, mas juntas: um lugar próprio no mapa.* → **raridade · …** · *N dos M estilos têm menos de 10 faixas no acervo inteiro.* |
| 4 | 33–41 s | voa até as duas maiores fusões | — | **fusão · …** · *… fica entre A e B: na vizinhança, X% A e Y% B.* |
| 5 | 41–49 s | o mapa inteiro; no fim, gira em 3D (yaw 0,9, pitch −0,35 rad, 2,8 s) | o ponteiro clica **Gêneros** (os pontos migram para as posições pelos rótulos), depois **Som** | **gêneros** · *No mapa Gêneros, a posição vem só dos rótulos…* → **som** · *No mapa Som, vem do áudio…* → **3D** · *O mapa também tem profundidade…* |
| 6 | 49–57 s | o grafo | o ponteiro clica **Grafo** (visão geral de todos os artistas); vai até o nome do artista escolhido e o grafo se centra nele; depois clica o primeiro vizinho em "Soa parecido com" e o grafo anda até ele | **grafo** · *No Grafo, cada nome é um artista, perto dos que soam como ele.* → **grafo · Nome** · *Nome, ligado aos artistas que mais soam como ele…* → **grafo · Vizinho** · *Clique num vizinho e o grafo anda até ele.* |
| 7 | 57–60 s | volta ao mapa inteiro | o ponteiro clica **Grafo** de novo, que fecha | **tocador.cc/atlas** · *Arraste, aproxime e clique numa faixa para ouvir.* |

Ao fim, o tour devolve mapa, filtros, grafo e seleção e deixa a câmera no mapa inteiro.

## De onde vêm os lugares e os números

Os "marcos" são os rótulos do mapa: a mediana de cada subgênero que forma um lugar (não está espalhado pelo mapa
todo), com quantas faixas tem (`A.marcos.som` no payload, feito por `script/build-atlas-web.js`).

- **Totais (cena 0):** os pontos do payload, por acervo.
- **Mainstream (cena 2):** o marco com mais faixas, e o maior de outro macro-gênero. A porcentagem é a fatia das
  faixas do mapa inteiro que têm aquele macro-gênero como cor.
- **Raridades (cena 3):** os dois menores marcos (com pelo menos 12 faixas), de macro-gêneros diferentes entre si e
  que não apareceram antes. "Estilos com menos de 10 faixas" conta os gêneros do payload que aparecem como gênero
  principal de 1 a 9 pontos.
- **Fusões (cena 4):** o mapa Som é dividido numa grade de 40×40. Para cada marco com 40 faixas ou mais, soma-se a
  vizinhança 3×3 da sua célula por macro-gênero (sem "Outros"): A é o macro-gênero do marco, B o outro mais
  presente ali. A nota da fusão é a menor das duas fatias, então ganha o lugar mais dividido ao meio; B precisa ter
  ao menos 20%. Entram as duas melhores com pares A–B diferentes.
- **Artista do grafo (cena 6):** entre as 400 faixas mais perto do marco mainstream, o artista que mais aparece
  (precisa dos catálogos carregados e de 3 faixas ou mais no grafo).
- **Zoom de cada voo:** o mínimo em que o mapa escreve o rótulo daquele marco (`n ≥ 1200 / z^1,7`, a regra de
  `desenharMarcos()`), com folga de 20%.

## Testes

`tests/atlas-tour.spec.js`: o botão aparece e fica ativo quando o mapa carrega, o tour começa e mostra a legenda,
Esc devolve mapa e câmera, `?tour=1` sai do endereço, `&t=` começa na cena certa, a câmera não fica parada mais
de 8 s.
