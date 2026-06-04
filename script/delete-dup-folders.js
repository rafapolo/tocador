#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const {
  S3Client,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} = require('@aws-sdk/client-s3');

const DRY_RUN = !process.argv.includes('--write');

// ── Config ────────────────────────────────────────────────────────────────────

function loadEnv(file = '.env') {
  const p = path.resolve(__dirname, '..', file);
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([\w]+)\s*=\s*"?([^"]*)"?\s*$/);
    if (m) process.env[m[1]] = m[2];
  }
}
loadEnv();

const UNZIPS = process.env.ARCHIVE_DIR || '/Volumes/EXTRA/hominiscanidae/unzips';
const ENDPOINT = process.env.S3_ENDPOINT;
const BUCKET = process.env.S3_BUCKET;
const PREFIX = process.env.S3_PREFIX || 'indie/';

const s3 = new S3Client({
  endpoint: ENDPOINT,
  region: 'us-east-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
  forcePathStyle: true,
});

// ── Duplicate paths to remove ─────────────────────────────────────────────────

const DUP_PATHS = [
  '2015 - humbra-tratados-do-amor-proprio-2015',
  '2025 - Os Fugitivos - Hominis Canidae #184 - Setembro',
  '2024 - Amaro Freitas Yy',
  '2024 - Echorec Face - Hominis Canidae #164 - Janeiro',
  '2023 - bike-arte-bruta-2023',
  '2023 - Economic Freedom Fighters Economic Freedom Fighters - Hominis Canidae #158 - Julho',
  '2023 - go-e-de-dentro-que-se-sai-2023',
  '2023 - Marchioretto Iii',
  '2023 - Marimbondo Oi Henrique',
  '2023 - mateus-alves-mateus-alves-2023',
  '2023 - p-f-filipini-interlude-2023',
  '2023 - primeiras vezes em sampa - Hominis Canidae #157 - Junho',
  '2023 - Satanique Samba Trio - Hominis Canidae #152 - Janeiro',
  '2023 - Tori - Hominis Canidae #153 - Fevereiro',
  '2022 - caustico-live-demo-i-2022',
  '2022 - Nosso Querido Figueiredo Everest Deluxe',
  '2022 - Tiago Sá - Hominis Canidae #140 - Janeiro',
  '2021 - A Casa Mais Estranha Nao Tem Numero',
  '2021 - Amaro Mann Riegulate - Hominis Canidae #136 - Setembro',
  '2021 - Repetentes 2008 - Hominis Canidae #132 - Maio',
  '2021 - Schnneider, BEX, Makalister - Hominis Canidae #131 - Abril',
  '2020 - acavernus-drones-2020',
  '2020 - Bao - Hominis Canidae #118 - Março',
  '2020 - Carabobina - Hominis Canidae #127 - Dezembro',
  '2020 - Martins - Hominis Canidae #117 - Fevereiro',
  '2020 - Shower Curtain - Hominis Canidae #119 - Abril',
  '2020 - Weird Fingers Paisagens Fugitivas',
  '2019 - Big Jesi Kroutons',
  '2019 - DJ Buck, Nikito, Cab, CAB - Hominis Canidae #114 - Novembro',
  '2019 - Douglas Germano - Hominis Canidae #112 - Setembro',
  '2019 - God Pussy - Hominis Canidae #109 - Junho',
  '2019 - Jards Macalé - HOMINIS CANIDAE - #HITSBR',
  '2019 - Lucindo - Hominis Canidae #110',
  '2019 - Santos Delusao Ep',
  '2018 - Cansei de Rigby - Hominis Canidae #94 - Março',
  '2018 - Chuva Chuva',
  '2018 - monophobia-gloom-2018',
  '2018 - Varandas Diorama',
  '2017 - Abencoada Roaming',
  '2017 - Coletanea - XmaZzZ, Especial de Natal NapNap Records',
  '2017 - Emerson Faria Terminal',
  '2017 - Infante 1991 Demos B Sides',
  '2017 - Nvs Casa',
  '2017 - Sabine Holler - Hominis Canidae #85 - Junho',
  '2016 - Felipe Neiva Meu Ep Ou Vida E Seu',
  '2016 - lanca-roda-2016',
  '2016 - Régis Martins & Cia Fantasma - Hominis Canidae #73 - Junho',
  '2015 - gudicarmas-dharma-2015',
  '2015 - Novampb - Hominis Canidae #64 - Setembro',
  '2015 - Sofia Freire - Hominis Canidae #66 - Novembro',
  '2015 - VICTIM! - Hominis Canidae #60 - Maio',
  '2013 - The Outside Dog - Outros Caminhos Parte I',
  '2020 - Crashkill - Hominis Canidae #120 - Maio',
];

// ── Helpers ───────────────────────────────────────────────────────────────────

async function listS3Keys(prefix) {
  const keys = [];
  let token;
  do {
    const res = await s3.send(new ListObjectsV2Command({
      Bucket: BUCKET, Prefix: prefix, ContinuationToken: token,
    }));
    (res.Contents || []).forEach(o => keys.push(o.Key));
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

async function deleteS3Keys(keys) {
  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000).map(Key => ({ Key }));
    await s3.send(new DeleteObjectsCommand({
      Bucket: BUCKET,
      Delete: { Objects: batch, Quiet: true },
    }));
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

(async () => {
  let localDeleted = 0, localSkipped = 0;
  let s3Deleted = 0;

  for (const p of DUP_PATHS) {
    const localPath = path.join(UNZIPS, p);
    const s3Prefix = PREFIX + p + '/';

    // local
    if (fs.existsSync(localPath)) {
      if (DRY_RUN) {
        console.log('local  DRY: rm -rf "' + localPath + '"');
      } else {
        fs.rmSync(localPath, { recursive: true, force: true });
        console.log('local  DEL: ' + p);
      }
      localDeleted++;
    } else {
      localSkipped++;
    }

    // s3
    const keys = await listS3Keys(s3Prefix);
    if (keys.length > 0) {
      if (DRY_RUN) {
        console.log('s3     DRY: ' + keys.length + ' objects at ' + s3Prefix);
      } else {
        await deleteS3Keys(keys);
        console.log('s3     DEL: ' + keys.length + ' objects at ' + s3Prefix);
      }
      s3Deleted += keys.length;
    } else {
      console.log('s3    NONE: ' + s3Prefix);
    }

    process.stdout.write('');
  }

  console.log('\n--- Summary ---');
  console.log('Local folders: ' + localDeleted + ' ' + (DRY_RUN ? 'would delete' : 'deleted') + ', ' + localSkipped + ' skipped (missing)');
  console.log('S3 objects:    ' + s3Deleted + ' ' + (DRY_RUN ? 'would delete' : 'deleted'));
  if (DRY_RUN) console.log('\n(dry run — pass --write to apply)');
})();
