# P2P

O objetivo é que os ouvintes passem a música uns para os outros e o tocador dependa cada vez menos do S3.
Hoje toda faixa sai do bucket e passa pelo proxy (`cdn.tocador.cc`). Com o P2P:

- o S3 vira a **semente inicial** de cada faixa;
- os players **semeiam** o que tocam;
- o [GUN](https://gun.eco/) faz o papel de **tracker**: presença e sinalização WebRTC.

Âncoras sempre ligadas guardam o acervo inteiro. Um fiscal confere as cópias e publica, com assinatura, a
saúde de cada faixa. Uma faixa bem replicada para de usar o CDN e, depois, sai do bucket para um arquivo frio.

Tudo isso anda em fases, e cada uma só começa quando a anterior passa no seu **portão** (uma medição em
produção). **Estado em 2026-11-13: a G0 está pronta no branch `feat/p2p-gun` e falta medir o portão. Nenhum
ouvinte usa P2P ainda.**

Ideia e diagramas: [gist](https://gist.rodado.xyz/rafapolo/806bc23d00704c2a852285a750897b2e) ·
contexto anterior (WebTorrent + Yjs): [gist](https://gist.rodado.xyz/rafapolo/1d4625e9ea8f463f83dbaf9674a7979f).

## Fases

| fase | o que entra | portão para seguir |
|---|---|---|
| **G0** · medir e preparar | métrica de sobreposição, torrents, rotas no proxy | `overlapRatio` medido por 7 dias. Perto de 0: o P2P só serve à rádio sincronizada |
| **G1** · relay GUN e rádio semeando | `gun.tocador.cc`, `js/p2p.js` opt-in, web seed sempre ligado | 2 semanas na rádio sem mais erros de playback, com a fração `bytesPeers` medida |
| **G2** · âncoras e fiscal | `ancora/` (Docker / Raspberry Pi), `gun/fiscal.js`, doadores | ≥ 2 âncoras estáveis por 30 dias cobrindo o acervo. **Se não houver, o projeto para aqui** |
| **G3** · web seed atrasado | faixas replicadas tocam sem CDN; o web seed só entra se o buffer cair | < 1% dos plays dessas faixas usando a reserva, por 30 dias |
| **G4** · arquivo frio | faixas frias saem do bucket; restauração automática | lote piloto de 100 faixas com restauração de ponta a ponta |

Definições:

- **replicada**: ≥ 3 cópias completas verificadas pelo fiscal, ≥ 2 delas em âncoras, há 30 dias;
- **fria**: replicada há 90 dias, com o objeto já no arquivo frio.

## Sobreposição: vale a pena?

O P2P só ajuda quando dois ouvintes querem a mesma faixa mais ou menos ao mesmo tempo. Por isso o `/metrics`
(`today`, zera à meia-noite de São Paulo) conta:

| campo | o que é |
|---|---|
| `overlapPlays` | plays cuja faixa outro aparelho começou nos 5 min anteriores |
| `overlapRatio` | `overlapPlays / plays`: o teto do que o P2P poderia servir |
| `overlapPorOrigem` | o mesmo, separado em `radio` (Referer = página da rádio) e `player`. A rádio infla o número, porque seus ouvintes ouvem a mesma faixa juntos |
| `p2p` | `beacons`, `peers_MB`, `seed_MB`: o que os players P2P relatam (G1 em diante) |

Detalhes da contagem:

- usa o mesmo dedup do `topTracks`: um aparelho conta uma vez por faixa a cada 30 min;
- só compara aparelhos diferentes;
- NFD e NFC contam como a mesma faixa;
- as sondas `curl/` do `cdn-health-monitor.yml` não contam como play;
- código: `markOverlap()` em `lib/metrics.js`.

Como `today.*` também zera a cada deploy do proxy, o `.github/workflows/p2p-sobreposicao.yml` lê o `/metrics`
todo dia às 23:50 e anota a leitura numa issue "[p2p] sobreposição diária (portão G0)". Um `uptimeH` abaixo
de 24 indica que houve deploy no dia e que a contagem é parcial. O workflow só roda a partir da `main`.

## Torrents

Cada faixa vira um torrent de um arquivo só (BEP 3):

- **peças de 1 MiB**;
- **`url-list`** com a URL da faixa no CDN (web seed, BEP 19). Ele fica fora do `info`, então trocar o CDN
  não muda o infohash;
- **sem `announce`**: o tracker é o GUN;
- **`name`** com o nome do arquivo em NFC, porque o nome entra no infohash.

`script/build-torrents.js` lê cada MP3 direto do bucket, com assinatura, sem passar pelo proxy e seus
limites. Os buckets misturam NFD e NFC, então ele tenta as duas formas. Ele grava:

- `torrents/<acervo>/<infohash>.torrent` no bucket do acervo (`uqt → sambaraiz`, `homi → indie`);
- `data/torrents/<acervo>.jsonl`, o progresso (fora do git). Rodar de novo retoma de onde parou;
- `data/torrents-<acervo>.json.gz`, o manifest (commitado):
  `{ v: 1, acervo, peca, h: [atlasKeyHash(chave)], ih: [infohash], len: [bytes] }`. A chave é
  `<álbum>/<arquivo>` em NFC, com o mesmo hash do `/atlas`, para não depender da ordem do catálogo. Se duas
  chaves tiverem o mesmo hash de 32 bits, a segunda fica fora e o script avisa.

```bash
set -a; . ./.env; set +a
bun script/build-torrents.js --acervo uqt --top --dry-run   # as mais tocadas hoje (topTracks do /metrics)
bun script/build-torrents.js --acervo homi --top
bun script/build-torrents.js --acervo homi --all --limit 500   # o resto do acervo, aos poucos
bun script/build-torrents.js --acervo uqt --keys lista.txt     # uma chave por linha
```

A rádio sorteia do acervo inteiro (`pickRandom()` em `js/radio.js`), então não existe um conjunto "da rádio".
Comece pelo `--top` e avance com `--all --limit`. O bencode é do próprio script, sem dependência. O teste
(`script/build-torrents.test.js`) confere o infohash contra um vetor calculado à parte, em Python.

## Rotas do proxy

**`GET /t/<uqt|homi>/<infohash>.torrent`**

- devolve o `.torrent` do bucket do acervo;
- `application/x-bittorrent` e `Cache-Control: immutable`, porque o arquivo é endereçado pelo hash;
- mesma regra de Referer que o áudio, já que o torrent traz a URL do web seed;
- qualquer outro caminho sob `/t/` dá 404 sem consultar o S3.

**`POST /play-beacon`**

Corpo: `{ acervo, path: '<álbum>/<arquivo>', fonte: 'cdn'|'p2p', bytesPeers, bytesSeed }`.

- Um play `cdn` já foi contado pelo Range 0 do áudio. Só `fonte: 'p2p'` chama `markPlay()`, com a mesma
  chave de aparelho e o mesmo caminho `<prefixo>/<álbum>/<arquivo>` que o GET teria usado.
- Os bytes vão para `today.p2p`.
- Exige Referer de uma página nossa e tem balde próprio por IP (20, recarga de 1 a cada 5 s), além da
  `location` no `nginx.conf`.
- No `sendBeacon`, mande o corpo como `text/plain`: um Blob `application/json` dispara preflight. O proxy
  lê o JSON de qualquer jeito.

Os dois caminhos estão no `Disallow` do `robots.txt`. Testes: `tests/proxy-p2p.test.js`, que roda o proxy real
contra o S3 falso de `tests/fixtures/proxy-harness.js`.

## Web seed e limites do proxy

O web seed pede cada peça de 1 MiB como um Range próprio:

- **Balde por aparelho** (30, recarga de 0,5/s): uma faixa de ~7 MB (8 peças) passa folgada.
- **5 streams simultâneos por aparelho**: é o limite que aperta. O slot só é liberado quando o corpo
  termina, então 8 peças pedidas ao mesmo tempo deixam algumas com 429 (`Retry-After: 5`). No G1, o
  WebTorrent tem de ter **no máximo 4 pedidos em voo** ao web seed.
- **`limit_req` do nginx** (5 r/s, burst 8, por IP): uma faixa longa (30+ peças) buscada a mais de 5 peças
  por segundo esbarra nele.

A medição com o WebTorrent de verdade fica para o G1.

## Tamanho do acervo e arquivo frio

Medido em 2026-11-13 (`Bun.S3Client.list()`, só leitura):

| bucket/prefixo | objetos | total | MP3 |
|---|---|---|---|
| `sambaraiz/uqt/` | 40.374 | 171,8 GB | 31.900 faixas, 171,1 GB |
| `indie/indie/` | 80.766 | 430,9 GB | 60.852 faixas, 429,7 GB |

Uma âncora com o acervo inteiro precisa de **~650 GB** com folga, então um disco de 1 TB serve.

**Arquivo frio (G4): Hetzner Storage Box**, plano de 1 TB, preço a conferir na contratação. Em vez do Glacier
Deep Archive porque:

- durante a restauração a faixa fica indisponível, e as até 12 h do Glacier são tempo demais;
- o Storage Box está no mesmo provedor do Object Storage, sem custo de saída, e copia por rsync/SFTP;
- o Deep Archive cobra saída e recuperação a cada restauração, o que come a economia num acervo de 0,6 TB.

Rever a escolha se o acervo passar de alguns TB.

## Riscos

- **O relay GUN vira o novo ponto central.** Ter dois relays e um tracker WSS público como reserva.
- **Spam no grafo aberto.** A validação de escrita e o limite por IP têm de existir antes de abrir ao público.
- **Privacidade.** O P2P é sempre opt-in e explica que os outros ouvintes da faixa veem seu IP.
- **O GUN não apaga nada.** A presença expira por timestamp. Vigiar o tamanho do `radata`.
- **Dado não confiável.** Tudo o que vem do GUN vai por `textContent`, nunca `innerHTML`.
- **Direitos.** Uma faixa distribuída não volta. Decidir o que fica fora do P2P antes do G4.
