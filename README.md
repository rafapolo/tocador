# 🎵 Tocador

Um player web para acervos musicais. Aponte para qualquer arquivo `.json.gz` compatível e toque.

Sem build. Sem dependências pesadas. Funciona em qualquer CDN estática.

**Demo ao vivo →** `https://rafapolo.github.io/tocador/`  
_(carrega o Acervo UQT por padrão — 1.658 horas de MPB)_

---

## ✨ Funcionalidades

### 🎨 Interface

- **Grid virtual de álbuns** — renderiza apenas ~30 cards no DOM independente do tamanho do acervo; ResizeObserver recalcula colunas ao redimensionar
- **Painel de faixas** — clique num álbum para ver capa, info e lista de faixas (desktop) ou drawer deslizante (mobile)
- **Capas lazy-loaded** — placeholder SVG embutido enquanto carrega; fallback silencioso em erro
- **Player compacto** — barra sticky no rodapé com capa, título, progresso e controles

### 🔍 Busca e Filtros

- **Busca em tempo real** — filtra por artista, título de álbum, path e títulos de faixas — debounce de 150ms
- **Filtro por década** — botões gerados automaticamente dos dados (`Todos | <1940 | 1950 … 2010 | ∞`)
- **Filtros combinados** — busca + década funcionam juntos
- **Deep links** — `?album=`, `?t=`, `?q=`, `?ano=`, `?play=1` preservados na URL; compartilhe qualquer faixa com link direto
- **Histórico** — navegação por browser back/forward restaura seleção e filtros

### 🎼 Áudio

- **Seleção intencional** — clique no álbum carrega sem tocar; play começa quando o usuário pede
- **Auto-próxima** — avança automaticamente ao terminar a faixa
- **Barra de progresso** — clique ou toque para pular; ponto de posição sempre visível; área de toque ampla
- **Shuffle** — aleatório ponderado por faixas em O(1), sem alocações
- **Repeat** — off → repetir faixa → repetir álbum
- **Volume** — slider no player desktop
- **Persistência** — shuffle, repeat e volume salvos no `localStorage`
- **Media Session API** — controles na tela de bloqueio e fones Bluetooth
- **Singleton entre abas** — pausa automaticamente outras abas via `BroadcastChannel`

### ♿ Acessibilidade

- Navegação completa por teclado — `Tab`, `Enter`, `Espaço` em todos os elementos interativos
- `aria-label` em todos os botões de ícone; `aria-pressed` em shuffle e repeat; `aria-live` anuncia faixa atual
- `role="slider"` + `aria-valuenow` atualizado em tempo real na barra de progresso
- HTML semântico — `<nav>` para décadas, `role="list"` no grid, `<label>` no campo de busca
- Focus-visible explícito em todos os elementos

### 📱 Mobile

- Header compacto de 44px com stats inline
- Grid de álbuns em tela cheia
- Drawer deslizante de faixas no player (toggle ☰)
- Overlay full-screen de "now playing" com swipe-to-dismiss

### ⌨️ Atalhos

| tecla | ação |
|---|---|
| `Espaço` | play / pausa |
| `←` / `→` | recua / avança 10s |
| `n` | próxima faixa |
| `p` | faixa anterior |
| `/` | foca busca |

---

## 📦 Acervos

O Tocador usa `?acervo=` para saber qual arquivo carregar.

```
https://rafapolo.github.io/tocador/?acervo=<url_encoded>
```

Uma vez carregado, o acervo persiste na sessão — recarregar sem o parâmetro mantém o mesmo.

### Aliases prontos

| alias | acervo |
|---|---|
| `?acervo=uqt` | Acervo UQT — 2.155 álbuns, 1.658h de MPB |

### Padrão

Sem `?acervo=` → carrega o Acervo UQT automaticamente.

---

## 🗂️ Formato do acervo

Um `.json.gz` com esta estrutura:

```json
{
  "meta": {
    "title": "Meu Acervo",
    "subtitle": "Subtítulo",
    "hours": "42",
    "base_url": "https://cdn.exemplo.com/musicas"
  },
  "albums": [
    {
      "title": "Nome do Álbum",
      "artist": "Artista",
      "year": 1975,
      "path": "1975 - Artista - Nome do Álbum",
      "has_cover": true,
      "tracks": [
        {
          "title": "Nome da Faixa",
          "num": 1,
          "file": "01 Nome da Faixa.mp3",
          "artists": "Artista",
          "duration": 214
        }
      ]
    }
  ]
}
```

`base_url + "/" + path + "/" + file` → URL do áudio  
`base_url + "/" + path + "/capa-min.jpg"` → capa do álbum

---

## 🛠️ Criar um acervo

Veja [`script/README.md`](script/README.md) para o guia completo em pt-BR:

- Como organizar as pastas de músicas
- Como limpar arquivos indesejados
- Como compilar e usar o **gerador Rust** (`script/generate-albums/`)
- Como hospedar o `.json.gz` no S3, R2 ou GitHub Releases

---

## 🏗️ Arquitetura

```
index.html                     app shell
js/ui.js                       toda a lógica — player, grid virtual, filtros, áudio
assets/player.css              estilos
assets/capa.jpg                placeholder de capa
script/generate-albums/        gerador Rust — lê MP3s, escreve .json.gz
script/README.md               guia para criar acervos (pt-BR)
```

Dependências de frontend: [Umbrella JS](https://umbrellajs.com/) (~2.6 KB). Descompressão via `DecompressionStream` nativa. Zero bundler. Zero framework.

---

## ⚡ Performance

- **Virtual scrolling** — `VirtualGrid` mantém ~30 nós no DOM; pool de nós reciclados reduz 65% das alocações em scroll
- **Gzip assíncrono** — `DecompressionStream` nativa descomprime o catálogo sem bloquear a thread principal
- **Event delegation** — 3 listeners cobrem todo o grid, em vez de um por álbum
- **Hot-path DOM cacheado** — 9 elementos críticos inicializados uma vez no boot; zero `getElementById` durante playback
- **Pre-lowercase** — strings de busca normalizadas em `buildAlbums()` → zero `.toLowerCase()` por chamada de filtro
- **Track list diffing** — troca de faixa no mesmo álbum só atualiza `.playing`, sem reconstruir o DOM

---

**Feito para tocar** ♪
