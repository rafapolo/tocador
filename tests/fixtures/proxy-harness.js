// Boots the real proxy.js as a subprocess against a fake S3 that stores keys byte-exactly
// and answers like the real one (Hetzner's Ceph): 206 with the real total, 416 with no
// Content-Range for a range past the end. Shared by the bun tests that need the whole
// request path (URL decode → checks → signed fetch → passthrough), not just a helper.

export function proxyHarness() {
  const h = { stored: new Map(), requested: [], s3: null, proc: null, port: 0 };

  h.startFakeS3 = () => Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      const u = new URL(req.url);
      // Strip "/<bucket>/" and decode per segment, exactly as S3 would. No normalization.
      const segs = u.pathname.replace(/^\/+/, '').split('/');
      segs.shift();
      const key = segs.map(decodeURIComponent).join('/');
      h.requested.push({ key, range: req.headers.get('range') });

      const body = h.stored.get(key);
      if (!body) return new Response('<Error>NoSuchKey</Error>', { status: 404 });

      const range = req.headers.get('range');
      if (range) {
        const m = /^bytes=(\d*)-(\d*)$/.exec(range);
        let start = Number(m[1]), end = m[2] ? Math.min(Number(m[2]), body.length - 1) : body.length - 1;
        if (m[1] === '') { start = Math.max(0, body.length - Number(m[2])); end = body.length - 1; }
        if (start >= body.length) {
          return new Response('<Error><Code>InvalidRange</Code></Error>', {
            status: 416, headers: { 'Accept-Ranges': 'bytes', 'Content-Type': 'application/xml' },
          });
        }
        return new Response(body.subarray(start, end + 1), {
          status: 206,
          headers: {
            'Content-Range': `bytes ${start}-${end}/${body.length}`,
            'Content-Length': String(end - start + 1),
            'ETag': '"fake"',
          },
        });
      }
      return new Response(body, { status: 200, headers: { 'Content-Length': String(body.length), 'ETag': '"fake"' } });
    },
  });

  h.start = async () => {
    h.s3 = h.startFakeS3();
    h.port = 20000 + Math.floor(Math.random() * 20000);
    h.proc = Bun.spawn(['bun', `${import.meta.dir}/../../proxy.js`], {
      env: {
        ...process.env,
        PORT: String(h.port),
        S3_ENDPOINT: `http://127.0.0.1:${h.s3.port}`,
        S3_BUCKET: 'testbucket',
        S3_BUCKET_MAP: '',
        AWS_ACCESS_KEY_ID: 'test',
        AWS_SECRET_ACCESS_KEY: 'test',
      },
      stdout: 'ignore',
      stderr: 'ignore',
    });
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      try { await fetch(`http://127.0.0.1:${h.port}/health`); return; } catch { await Bun.sleep(50); }
    }
    throw new Error(`proxy did not come up on :${h.port}`);
  };

  h.stop = () => { h.proc?.kill(); h.s3?.stop(true); };

  h.reset = (entries) => { h.stored = new Map(entries); h.requested = []; };

  h.url = (key) => `http://127.0.0.1:${h.port}/${key.split('/').map(encodeURIComponent).join('/')}`;

  return h;
}
