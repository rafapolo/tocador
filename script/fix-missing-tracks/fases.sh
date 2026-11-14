#!/bin/bash
# Encadeia o resto (ver tasks/fix-missing-tracks.md): espera os lotes, junta os resultados,
# troca para o worker/jobs novos e roda os álbuns reabertos (HC remapeado, stream aceito).
cd /mnt/COLD/fix-missing-tracks
set -a; . ./.env; set +a
while pgrep -f "worker.py jobs.jsonl" >/dev/null || pgrep -f "worker-bc.py" >/dev/null || pgrep -f "worker-totais.py" >/dev/null; do sleep 60; done
echo "$(date) lotes principal, bandcamp e totais terminaram" >> fases.log
for f in results-bandcamp.jsonl results-totais.jsonl; do [ -f $f ] && cat $f >> results.jsonl && mv $f ${f%.jsonl}.merged.jsonl; done
cp worker.py worker-v1.py; cp staged/worker.py worker.py; cp jobs.jsonl jobs-v1.jsonl; cp staged/jobs.jsonl jobs.jsonl
.venv/bin/python worker.py jobs.jsonl results.jsonl --workers 8 --aceitar-stream > worker-fase2.log 2>&1
.venv/bin/python worker.py jobs-totais.jsonl results.jsonl --workers 8 --aceitar-stream > worker-totais2.log 2>&1
echo "$(date) FIM" >> fases.log
