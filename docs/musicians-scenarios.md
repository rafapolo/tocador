# A banda do Atlas: músicos e cenários

A banda é a sonificação do `/atlas` tocada por músicos em 3D, num cartão à esquerda do mapa. Ela abre de três jeitos:
o botão **Simulação** (grupo próprio nos controles, depois do Sonificar), `?sim=1` ou `/atlas/sim`.

- **Código:** `js/atlas-sim.js`. O motor de som que ela escuta é `js/atlas-som.js`, e as famílias de gênero vêm de
  `js/atlas-receitas.js`.
- **Testes:** `tests/atlas-sim.spec.js`.

O mapa continua navegável por trás: andar por ele muda o que a sonificação toca, e com isso quem está no palco e o
cenário.

## De onde vêm os músicos

Nada é inventado: cada músico é uma voz real do motor de som.

- **Evento de nota:** `criarMotorSom()` emite `{ papel, familia, t, vel, timbre }` para cada golpe ou nota que agenda.
  Sem ninguém ouvindo, a emissão não faz nada, e ouvir não muda o som.
- **Sincronia:**
  - O motor agenda ~0,1 s à frente, então a banda guarda os eventos numa fila.
  - Cada nota só aparece quando sai no alto-falante (`ouvido()`). Esse instante vem do `getOutputTimestamp()` do
    `AudioContext`, ou do `currentTime` menos a `outputLatency`, e não do `currentTime` puro. Medido no Mac, nas caixas:
    77 ms de diferença. No Bluetooth passa de 150 ms.
  - Golpe: nos 140 ms antes da próxima nota de um músico, o braço que vai tocar sobe (`preparo`); na nota, desce
    abaixo do repouso (`golpe`). A batida cai em cima do som, e na percussão as mãos se alternam.
  - O pulso da dança vem do próprio motor (`batidaEm(T)`: o tick agendado e o andamento atual), lido no instante
    ouvido. Assim os corpos não derivam do ritmo, como derivava um relógio à parte.
- **Ganchos:** `__atlas.ouvirBanda(fn)`, `__atlas.agoraSom()`, `__atlas.ouvidoSom()`, `__atlas.batidaSom()` e
  `__atlas.familia(f)` (`{ cor, nome }`).

### Um músico por família × grupo × instrumento

| Grupo | Papéis do motor | Onde fica no palco |
|---|---|---|
| percussão | `bumbo`, `surdo`, `zabumba`, `caixa`, `aro`, `palma`, `chimbal`, `aberto`, `prato`, `tamborim`, `ganza`, `pandeiro`, `repique`, `cuica`, `agogo`, `triangulo`, `clave`, `cowbell`, `conga`, `bongo`, `estalo` | fundo |
| baixo | `baixo` | meio |
| harmonia | `acorde` | frente |
| melodia | `mel` | frente |

- O percussionista de uma família junta as peças que já tocou. A legenda mostra as três últimas, por exemplo
  "pandeiro, cuíca, tamborim".
- No arco do palco, os músicos ficam agrupados por família, na ordem em que entraram.

### Instrumento e pose pelo timbre

| Timbre do motor | Instrumento em cena | Pose |
|---|---|---|
| `violao`, `violao7`, `cavaco`, `bandolim`, `banjo`, `guitarra`, `dist`, `baixo`, `sub` | corpo de corda, num tamanho por instrumento (cavaquinho 0,62 … baixo 1,15) | dedilhado |
| `contrabaixo` | contrabaixo em pé | arco |
| `sanfona` | sanfona no peito | abre e fecha no golpe |
| `piano`, `rhodes`, `cravo`, `orgao`, `acid`, `lead`, `chip`, `pad`, `padQuente`, `vibrafone`, `sino`, `caixinha` | teclado no suporte (metálico para vibrafone e sinos) | as duas mãos |
| `voz`, `coro` | pedestal com microfone | mão no microfone |
| `sopro`, `flauta`, `apito`, `cordas` | tubo à boca (flauta de lado; violino em madeira) | braços erguidos |
| percussão | surdo na cintura | baquetas alternadas |

### Quem entra e quem sai

- **Máximo de 8 no palco.** Quem está saindo não conta.
- **Troca de instrumento:** se a voz de uma família troca de instrumento (cavaquinho → flauta), quem tocava o antigo
  sai e entra quem toca o novo.
- **Palco cheio:** a voz nova entra no lugar de quem está calado há mais tempo, desde que esse músico esteja calado
  há pelo menos 1 s. Se não estiver, a voz nova espera.
- **Silêncio:** quem fica calado por 5 s sai do palco. Os músicos entram pela frente e somem diminuindo e ficando
  transparentes.

### Braços

Cada braço tem três juntas: ombro, cotovelo e punho (`junta()`).

- **Percussão:** o percussionista segura baquetas. Na preparação, o cotovelo sobe e dobra e o punho leva a baqueta
  para cima. Na nota, o punho estala para baixo, com um pequeno rebote. As mãos se alternam.
- **Cordas:** a mão esquerda fica no braço do instrumento e a direita palheta, subindo antes da nota e descendo nela.
- **Teclado, sanfona, voz, sopro e contrabaixo:** cada um tem a sua pose, com preparação e golpe próprios.

### O cartão

- **Instrumentos · ao vivo:** painel recolhível no alto do cartão, acima do palco. Começa fechado, e só aberto as
  notas são somadas. Mostra a parte de cada instrumento nos últimos segundos (meia-vida de 2 s) e lembra se estava
  aberto (`localStorage`).
- **Dica:** embaixo do palco, no estilo do `#dica` do mapa: o instrumento de quem está em foco, a família e o tipo
  de plano.
- **No desktop:** arrastar a faixa de cima move o cartão, e o canto de baixo à direita redimensiona a largura e a
  altura do palco. O cartão fica dentro da janela e lembra o lugar; um duplo clique na faixa de cima volta ao
  padrão.

### Corpo e dança

- **Corpo:** boneco de madeira em primitivas: pernas, tronco, cabeça com olhos voltados para a plateia, e braços que
  giram no ombro.
- **Cores:**
  - A camisa usa a cor do macrogênero, com um desvio de matiz e luz por família. Samba, MPB e forró são todos
    "Latino", e sem o desvio teriam a mesma cor.
  - O tom de pele é sorteado de forma fixa pela chave do músico, então o mesmo músico tem sempre a mesma cara.
- **Dança:**
  - O corpo desce a cada batida e balança o tronco e a cabeça no andamento da banda, lido do motor duas vezes por
    segundo.
  - A amplitude cresce com a energia de quem está tocando.
  - Cada nota acende a camisa e dispara o golpe do braço.

## Cenários

Cada família de gênero leva a um cenário (`CENARIOS`):

| Cenário | Famílias | Céu (alto → horizonte), chão | Objetos |
|---|---|---|---|
| **praia** (Rio) | bossa, mpb, reggae, ska, dub, salsa | azul → laranja, areia | mar com linha de onda, Pão de Açúcar e Urca, sol no horizonte, coqueiros |
| **roda** (samba no morro) | samba, batucada, fanfarra, infantil | noite azul → roxo, terracota | dois morros com casinhas coloridas, varal de lâmpadas sobre o palco, mesa de bar com copo |
| **sertão** (festa) | forro, country | noite → laranja, terra | cactos, bandeirinhas, fogueira tremendo, lua |
| **campo** | folk, neofolk, africa, afrobeat | azul-claro, grama | árvores, colinas |
| **taverna** | tango, bolero, flamenco, fado, laiko, manouche | escuro quente, madeira | parede de tijolos, barris, lâmpadas penduradas piscando de leve |
| **garagem** | rock, alternativo, punk, hardcore, metal, black, doom, psicodelico, postrock | preto → vermelho, concreto | pilhas de amplificador, treliça, refletores vermelhos pulsando |
| **rua** | boombap, trap, nuvem, reggaeton, fala | roxo de fim de tarde, asfalto | prédios, muro com grafite, postes |
| **clube** | house, techno, electro, dnb, synthpop, pop | preto → violeta, piso escuro | barras de neon, lasers varrendo, globo espelhado girando |
| **espaço** | ambient, experimental, ruido, dream, downtempo, cinema | índigo, quase preto | 300 estrelas, planeta com anel, esferas flutuando |
| **jazz** | jazz, jazzcontemporaneo, blues, soul, funk | azul-noite, madeira | cortina vermelha, mesinhas com vela |
| **teatro** | classica, contemporanea, balada, valsa | escuro quente, madeira | colunas, cortina, lustre |

### Como os cenários se misturam

1. **Peso bruto** (`pesarCenarios()`): para cada cenário, soma `vis × (0,6 + energia)` dos músicos das famílias dele.
   `vis` é o quanto o músico já apareceu e `energia`, o quanto ele toca agora.
2. **Normalização:** os pesos são divididos pelo maior, então o cenário dominante fica inteiro.
3. **Suavização:** cada peso vai até o novo valor aos poucos (~1,5 s), para os cenários entrarem e saírem devagar.
4. **Construção sob demanda:** um cenário só é montado quando passa de 0,05 pela primeira vez.
5. **Objetos** (`aplicarCenarios()`): sobem do chão (escala vertical = peso × 1,4) e ganham opacidade (peso × 1,6).
   Cada cenário sorteia os ângulos dos seus objetos (sempre os mesmos), então dois cenários presentes se intercalam
   no mesmo anel, atrás e dos lados do palco.
6. **Ambiente:** céu (uma esfera com gradiente), névoa, chão e luz são a média dos cenários, ponderada pelos pesos.
   Sem ninguém no palco, fica o escuro do atlas.

Exemplo, na região da Bossa Nova no mapa: a praia domina, o morro do samba aparece atrás e as bandeirinhas do forró
cruzam o céu.

## Direção de clipe

### Planos

A câmera trabalha por planos, com **corte seco na batida**: a cada 8 tempos, ou 4 quando algum músico está "quente"
(energia > 0,8). O tipo de plano é sorteado com pesos, sem repetir o anterior, e enquadra quem tocou mais forte há
pouco. Dentro do plano a câmera anda devagar (`dirigir()`).

| Plano | Peso | Enquadra | Movimento |
|---|---|---|---|
| close | 3 | rosto e mãos | aproxima |
| médio | 3 | corpo inteiro | gira em volta |
| contra-plongée | 2 | de baixo para cima, "herói" | desliza de lado |
| dois | 2 | os dois que mais tocam | fecha o enquadramento |
| travelling | 1,5 | desliza pela frente da banda | de um lado ao outro |
| aberto | 1,5 | a banda inteira | grua subindo e descendo |

- O nome de quem está no plano aparece embaixo, por exemplo "pandeiro, cuíca · Samba".
- **Movimento reduzido:** só o plano aberto, parado, sem dança e sem animar os objetos. As luzes continuam
  respondendo às notas.

### Luz e imagem de filme

- **Tom:** tone mapping ACES (a curva de filme), exposição 0,95, com um clarão de até +0,3 em cada golpe forte de
  bumbo, surdo ou prato.
- **Luzes:** contraluz na cor do cenário, que desenha a silhueta dos músicos, e uma luz principal quente.
- **Fachos:** um cone aditivo sobre cada músico, na cor da família, que acende com o que ele toca. De perto o facho
  some, porque com a câmera dentro do cone a luz lavaria a imagem.
- **Poeira:** 240 partículas aditivas flutuando nos fachos, animadas no shader.
- **Sombra:** um disco desfocado sob os pés, no lugar de um shadow map.
- **Vinheta e grão de filme:** por CSS sobre o canvas (`#sim::after`), sem custo para o WebGL.

### Corpo em movimento

- Os joelhos dobram em cada batida, e o peso passa de um pé ao outro a cada duas.
- O tronco se inclina no golpe e gira devagar.
- A cabeça acena com um pequeno atraso, como quem sente a música.
- O cabelo, os sapatos e o tom de pele são sorteados de forma fixa por músico.

## Desempenho

- **Geometrias compartilhadas:** cada peça de músico (perna, cabeça, surdo…) existe uma vez só (`GEO`). Sair do palco
  descarta só os materiais.
- **Transparência só quando precisa:** os materiais são opacos e só ficam transparentes enquanto o músico ou o cenário
  aparece ou some (`opacidade()`). Transparência custa ordenação e sobreposição de pixels.
- **Nada alocado por quadro:** listas de músicos ativos, cores da mistura e vetores da câmera são reaproveitados.
- **Fila de notas:** chega quase sempre em ordem, então só é reordenada quando uma nota chega fora de ordem.
- **DOM:** o texto do plano e o aviso de palco vazio só são reescritos quando mudam.
- **Resolução adaptativa:** a média do tempo de quadro decide a densidade de pixels. Abaixo de ~40 fps ela desce um
  degrau (2 → 1,5 → 1,25 → 1); acima de ~55 fps volta a subir.
- **Medido no Mac:** 120 fps a 2×, com 8 músicos e quatro cenários misturados. `__atlasSim.estado()` mostra `fps`,
  `resolucao` e `plano`.

## A música manda no vídeo, nunca o contrário

- **O mapa é a partitura:** a banda não voa, não aproxima e não passeia pelo mapa. Só quem mexe no mapa muda a música,
  e a banda mostra o que ela toca.
- **Folga no agendamento:** com a banda aberta, o som agenda as notas 350 ms à frente, em vez de 140 ms (`folga()`
  em `js/atlas-som.js`). O agendador divide a thread com o 3D, e assim um quadro pesado não abre buraco no áudio. As
  notas caem no mesmo lugar do tempo; só são calculadas mais cedo.
- **Sem travas na abertura:** os shaders compilam antes do primeiro quadro (`compileAsync`), sem travar a thread.
- **Até 60 quadros por segundo:** numa tela de 120 Hz, desenhar o dobro só tiraria tempo do som.
- **A música não adormece:** com a banda visível, a sonificação não dorme depois de 60 s sem gesto, porque alguém
  está assistindo. Isso não muda o que ela toca.

## Teclas e som

- **Esc:** fecha a banda quando o foco está no cartão, mesmo com o three.js ainda carregando. Fora do cartão, Esc
  continua sendo do mapa (fecha o cartão da faixa ou o grafo).
- **T:** fica bloqueado com a banda aberta, porque o tour tomaria o mapa.
- **Som:** liga dentro do próprio clique de abrir, porque o Safari recusa som depois de um carregamento assíncrono.
  Se o Sonificar estava desligado, volta a ficar desligado ao fechar.
- **`?sim=1`:** espera o clique em "▶ Começar com som", porque sem um gesto o navegador não deixa tocar.

## Ideias para depois

- Plateia: bonecos menores dançando na beira do palco quando a banda está cheia.
- Objetos que respondem ao som: o mar sobe com o grave, as lâmpadas da roda piscam no surdo, os lasers seguem o
  chimbal.
- Cenários de transição entre famílias vizinhas, por exemplo bossa e jazz numa varanda de Copacabana à noite.
- Hora do dia pelo andamento: lento ao entardecer, rápido à noite.
- Instrumentos mais fiéis: pandeiro na mão, cuíca debaixo do braço, agogô e tamborim em vez do surdo genérico.
