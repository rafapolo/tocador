# Como criar um acervo para o Tocador

Um acervo é um arquivo `.json.gz` que descreve uma coleção de álbuns e faixas. O Tocador carrega esse arquivo pelo parâmetro `?acervo=<url>` e usa o campo `meta.base_url` para montar as URLs de áudio e capas.

---

## 1. Organização das pastas de músicas

Cada álbum deve estar em uma pasta própria dentro de um diretório raiz. O nome da pasta é usado como `path` no acervo e deve seguir um dos formatos abaixo para que o ano e artista sejam extraídos automaticamente:

```
2009 - Artista - Nome do Álbum/
Artista - Nome do Álbum (2009)/
Nome do Álbum (2009)/
```

As faixas dentro da pasta devem ser arquivos `.mp3`. Capas de álbum devem se chamar `capa.jpg`, `cover.jpg`, `folder.jpg` ou similar — o gerador reconhece automaticamente.

**Exemplo de estrutura:**

```
musicas/
  1975 - Elis Regina - Falso Brilhante/
    01 Como Nossos Pais.mp3
    02 Fascinação.mp3
    capa.jpg
  1978 - Milton Nascimento - Clube da Esquina 2/
    01 San Vicente.mp3
    02 Tudo Que Você Podia Ser.mp3
    cover.jpg
```

---

## 2. Gerar o acervo com o gerador Rust

O gerador lê os metadados ID3 dos arquivos `.mp3` em paralelo e produz um `.json.gz` compatível com o Tocador.

### Compilar

Requer Rust instalado (`rustup.rs`).

```bash
cd script/generate-albums
cargo build --release
```

O binário ficará em `script/generate-albums/target/release/generate-albums`.

### Usar

```bash
./generate-albums <pasta-de-musicas> [saida.json.gz] [opções]
```

**Opções de metadados do acervo:**

| flag | descrição |
|---|---|
| `--title` | Nome exibido no cabeçalho e na aba do navegador |
| `--subtitle` | Subtítulo abaixo do nome |
| `--hours` | Quantidade de horas (ex: `"42"` → exibe `42 horas`) |
| `--base-url` | URL raiz onde os arquivos de áudio e capas estão servidos |

**Exemplo completo:**

```bash
./generate-albums ~/musicas/meu-acervo acervo.json.gz \
  --title "Meu Acervo" \
  --subtitle "Rock Nacional dos Anos 80" \
  --hours "120" \
  --base-url "https://cdn.exemplo.com/musicas"
```

---

## 3. Limpeza antes de gerar

Antes de gerar o acervo é recomendável limpar arquivos indesejados da pasta de músicas:

```bash
# Remover arquivos ocultos do macOS
find musicas/ -name "._*" -delete
find musicas/ -name ".DS_Store" -delete

# Remover pastas vazias
find musicas/ -type d -empty -delete

# Listar arquivos que não são MP3 nem imagens (conferir manualmente)
find musicas/ -type f ! \( -iname "*.mp3" -o -iname "*.jpg" -o -iname "*.jpeg" -o -iname "*.png" \)
```

---

## 4. Estrutura do arquivo gerado

```json
{
  "meta": {
    "title": "Meu Acervo",
    "subtitle": "Rock Nacional dos Anos 80",
    "hours": "120",
    "base_url": "https://cdn.exemplo.com/musicas"
  },
  "albums": [
    {
      "title": "Nome do Álbum",
      "artist": "Artista",
      "year": 1985,
      "path": "1985 - Artista - Nome do Álbum",
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

O campo `path` é o nome da pasta do álbum. As URLs de áudio e capa são montadas como:

```
{base_url}/{path}/{file}          ← áudio
{base_url}/{path}/capa-min.jpg    ← capa
```

---

## 5. Hospedar o acervo

O `.json.gz` pode ser servido de qualquer lugar acessível publicamente — S3, Cloudflare R2, GitHub Releases, qualquer CDN. O Tocador faz um simples `fetch` com `DecompressionStream`.

**Exemplo com S3/R2:**

```bash
aws s3 cp acervo.json.gz s3://meu-bucket/acervo.json.gz \
  --content-type application/json \
  --content-encoding gzip \
  --acl public-read
```

**Exemplo com GitHub Releases (via gh CLI):**

```bash
gh release create v1 acervo.json.gz --title "Acervo v1"
```

---

## 6. Abrir no Tocador

Com o arquivo hospedado, encode a URL e passe como parâmetro:

```
https://tocador.exemplo.com/?acervo=https%3A%2F%2Fcdn.exemplo.com%2Facervo.json.gz
```

Ou crie um link direto:

```js
const url = 'https://cdn.exemplo.com/acervo.json.gz';
const tocadorUrl = `https://tocador.exemplo.com/?acervo=${encodeURIComponent(url)}`;
```

Uma vez carregado, o acervo fica salvo na sessão do navegador — recarregar a página sem o parâmetro mantém o mesmo acervo.
