# Scripts do Tocador

Scripts compartilhados para criar e manter acervos compatíveis com o Tocador. Todos os scripts lêem o diretório de músicas via variável de ambiente `ARCHIVE_DIR` (padrão: `../unzips`).

---

## Criar um acervo

### 1. Organizar as pastas de músicas

Cada álbum deve estar em uma pasta própria. O nome da pasta é usado como `path` no acervo e deve seguir um dos formatos abaixo para que ano e artista sejam extraídos automaticamente:

```
2009 - Artista - Nome do Álbum/
Artista - Nome do Álbum (2009)/
Nome do Álbum (2009)/
```

As faixas devem ser `.mp3`. Capas devem se chamar `capa.jpg`, `cover.jpg`, `folder.jpg` ou similar — o gerador detecta automaticamente e renomeia para `capa-min.jpg` durante o resize.

**Exemplo:**

```
musicas/
  1975 - Elis Regina - Falso Brilhante/
    01 Como Nossos Pais.mp3
    02 Fascinação.mp3
    capa.jpg
  1978 - Milton Nascimento - Clube da Esquina 2/
    01 San Vicente.mp3
    cover.jpg
```

### 2. Gerar o arquivo `.json.gz`

O gerador Rust lê os metadados ID3 dos `.mp3` em paralelo e produz um `.json.gz` compacto.

**Compilar** (requer [Rust](https://rustup.rs)):

```bash
cd script/generate-albums
cargo build --release
```

**Usar:**

```bash
./generate-albums <pasta-de-musicas> [saida.json.gz] [opções]
```

| flag | descrição |
|---|---|
| `--title` | Nome exibido no cabeçalho e na aba do navegador |
| `--subtitle` | Subtítulo abaixo do nome |
| `--hours` | Quantidade de horas (ex: `"42"` → exibe `42 horas`); calculado automaticamente se omitido |
| `--base-url` | URL raiz onde os arquivos de áudio e capas estão servidos |

**Exemplo:**

```bash
./generate-albums ~/musicas/meu-acervo acervo.json.gz \
  --title "Meu Acervo" \
  --subtitle "Rock Nacional dos Anos 80" \
  --base-url "https://cdn.exemplo.com/musicas"
```

### 3. Estrutura do arquivo gerado

```json
{
  "meta": {
    "title": "Meu Acervo",
    "subtitle": "Rock Nacional dos Anos 80",
    "base_url": "https://cdn.exemplo.com/musicas"
  },
  "albums": [
    {
      "title": "Nome do Álbum",
      "artist": "Artista",
      "year": 1985,
      "path": "1985 - Artista - Nome do Álbum",
      "tracks": [
        {
          "title": "Nome da Faixa",
          "file": "01 Nome da Faixa.mp3",
          "duration": 214
        },
        {
          "title": "Faixa de Artista Diferente",
          "num": 5,
          "file": "05 Outra Faixa.mp3",
          "artists": "Artista Convidado",
          "duration": 187
        }
      ]
    },
    {
      "title": "Álbum sem Capa",
      "artist": "Artista",
      "year": 1990,
      "path": "1990 - Artista - Álbum sem Capa",
      "has_cover": false,
      "tracks": [...]
    }
  ]
}
```

**Campos opcionais omitidos para compacidade:**

| campo | omitido quando |
|---|---|
| `track.artists` | igual ao `album.artist` — o player usa o artista do álbum como fallback |
| `track.num` | igual à posição na array + 1 (sequencial) — o player usa o índice como fallback |
| `album.has_cover` | ausente significa `true`; presente com valor `false` indica sem capa |

As URLs de áudio e capa são montadas pelo player como:

```
{base_url}/{path}/{file}          ← áudio
{base_url}/{path}/capa-min.jpg    ← capa
```

---

## Scripts disponíveis

### `generate-albums/` — Gerador de acervo (Rust)

Gera o `.json.gz` a partir de uma pasta de MP3s. Ver seção acima.

### `sync-to-bucket.js` — Sincronizar áudio para S3

Faz upload dos arquivos `.mp3` para o bucket S3.

```bash
ARCHIVE_DIR=/caminho/musicas node sync-to-bucket.js
```

Requer `.env` com `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `S3_ENDPOINT`, `S3_BUCKET`.

### `resize-cover-images.js` — Redimensionar e fazer upload das capas

Redimensiona capas para 200px de largura (`capa-min.jpg`) e faz upload para S3.

```bash
ARCHIVE_DIR=/caminho/musicas node resize-cover-images.js
```

### `extract-genres.py` — Classificação de gêneros com ML

Classifica cada faixa usando modelos Essentia (MAEST/discogs519). Gera `genres.json`.

```bash
ARCHIVE_DIR=/caminho/musicas python3 extract-genres.py --model discogs519 --workers 6
```

Requer: `essentia`, `tensorflow`, modelos em `script/models/`.

### `dedup-albums.js` — Detectar álbuns duplicados

Lista álbuns com títulos semelhantes para revisão manual.

### `filter-albums-by-s3.js` — Filtrar álbuns presentes no S3

Verifica quais álbuns do catálogo têm arquivos no bucket.

### `find-untagged.js` — Encontrar faixas sem tags ID3

Lista arquivos `.mp3` sem título, artista ou número de faixa nas tags.

### `fetch-covers.py` — Buscar capas faltando

Busca capas no MusicBrainz/Cover Art Archive para álbuns sem `capa.jpg`.

### `fix-missing-tags.py` / `fix-tags-*.py` — Corrigir tags ID3

Corrige tags usando AcoustID, AudD ou MusicBrainz Search.

---

## Hospedar o acervo

O `.json.gz` pode ser servido de qualquer lugar público — S3, Cloudflare R2, GitHub Releases, raw do GitHub.

**GitHub (raw):**

```
https://raw.githubusercontent.com/usuario/repo/refs/heads/main/acervo.json.gz
```

**S3/R2:**

```bash
aws s3 cp acervo.json.gz s3://meu-bucket/acervo.json.gz \
  --content-type application/json \
  --content-encoding gzip \
  --acl public-read
```

---

## Abrir no Tocador

```
https://tocador.exemplo.com/?acervo=https%3A%2F%2Fcdn.exemplo.com%2Facervo.json.gz
```

Ou com um alias registrado em `KNOWN_ACERVOS` no `ui.js`:

```
https://tocador.exemplo.com/?acervo=meu-acervo
```

Uma vez carregado, o acervo fica salvo na sessão — recarregar sem o parâmetro mantém o mesmo acervo.
