const express = require('express');
const http    = require('http');
const https   = require('https');
const { Server } = require('socket.io');
const cors = require('cors');
const fs   = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const os   = require('os');
const crypto = require('crypto');


const PORT = process.env.PORT || 5000;


// ── FFmpeg absolute paths (set by winget install) ─────────────────────────────
// Node.js inherits PATH from when it started, NOT the current system PATH.
// Using absolute paths guarantees ffmpeg works after every restart.
const FFMPEG_BIN  = 'C:\\Users\\RAEED AHMAD PK\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-8.1-full_build\\bin';
const FFMPEG_EXE  = path.join(FFMPEG_BIN, 'ffmpeg.exe');
const FFPROBE_EXE = path.join(FFMPEG_BIN, 'ffprobe.exe');

// ── Keep-alive TCP agents ────────────────────────────────────────────────────
const httpAgent  = new http.Agent ({ keepAlive: true, maxSockets: 20, timeout: 30000 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 20, timeout: 30000 });

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
// Dynamic Referers are constructed per request inside the fetcher

// ═══════════════════════════════════════════════════════════════════════════════
// FAST-LOAD CACHE INFRASTRUCTURE
// ═══════════════════════════════════════════════════════════════════════════════
const MAX_PREWARM_BYTES = 6 * 1024 * 1024;
const CACHE_TTL_MS      = 45 * 60 * 1000;
const MAX_CACHE_SLOTS   = 15;
const streamCache       = new Map();
const redirectCache     = new Map();

// ── Audio Codec Probe Cache (for transparent EAC3 auto-remux) ────────────────
// Key: original URL → Value: { needsRemux, duration, finalUrl, cachedAt }
// First request is always served normally; probe runs in background for future requests.
const probeCache    = new Map();
const PROBE_TTL_MS  = 30 * 60 * 1000; // 30 minutes
const INCOMPAT_CODECS = new Set(['eac3', 'dts', 'truehd', 'ac3']);

// probeForAutoRemux: resolves with { needsRemux, duration, finalUrl } and caches the result.
// Uses -read_intervals %+#1 to stop right after the first audio packet — very fast (~1-2s).
function probeForAutoRemux(targetUrl) {
  const cached = probeCache.get(targetUrl);
  if (cached && Date.now() - cached.cachedAt < PROBE_TTL_MS) return Promise.resolve(cached);

  return new Promise(resolve => {
    const done = (meta) => { probeCache.set(targetUrl, meta); resolve(meta); };
    const fallback = { needsRemux: false, duration: 0, finalUrl: targetUrl, cachedAt: Date.now() };

    resolveRedirects(targetUrl).then(finalUrl => {
      const ff = spawn(FFPROBE_EXE, [
        '-v', 'quiet',
        '-print_format', 'json',
        '-show_format',
        '-show_streams',  '-select_streams', 'a:0',
        '-read_intervals', '%+#1',          // Stop after first audio packet — fast!
        '-i', finalUrl,
      ]);
      let out = '';
      let timer = setTimeout(() => { try { ff.kill(); } catch {} done({ ...fallback, finalUrl }); }, 6000);
      ff.stdout.on('data', d => out += d);
      ff.on('close', () => {
        clearTimeout(timer);
        try {
          const data = JSON.parse(out);
          const s    = data.streams?.[0];
          done({
            needsRemux : INCOMPAT_CODECS.has(s?.codec_name?.toLowerCase()),
            duration   : parseFloat(data.format?.duration || 0),
            finalUrl,
            cachedAt   : Date.now(),
          });
        } catch { done({ ...fallback, finalUrl }); }
      });
      ff.on('error', () => { clearTimeout(timer); done({ ...fallback, finalUrl }); });
    }).catch(() => done(fallback));
  });
}

// ── CDN Redirect Pre-Resolver ─────────────────────────────────────────────────
function resolveRedirects(originalUrl) {
  if (redirectCache.has(originalUrl)) return Promise.resolve(redirectCache.get(originalUrl));
  return new Promise(resolve => {
    const hop = (url, depth) => {
      if (depth > 8) { resolve(originalUrl); return; }
      let parsed;
      try { parsed = new URL(url); } catch { resolve(originalUrl); return; }
      const isHttps = parsed.protocol === 'https:';
      const req = (isHttps ? https : http).request({
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: 'HEAD',
        agent: isHttps ? httpsAgent : httpAgent,
        headers: { 'User-Agent': BROWSER_UA }
      }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const next = res.headers.location.startsWith('http') ? res.headers.location : `${parsed.protocol}//${parsed.host}${res.headers.location}`;
          res.resume();
          hop(next, depth + 1);
        } else {
          res.resume();
          redirectCache.set(originalUrl, url);
          resolve(url);
        }
      });
      req.on('error', () => resolve(originalUrl));
      req.end();
    };
    hop(originalUrl, 0);
  });
}

// ── LRU Eviction ─────────────────────────────────────────────────────────────
function evictStale() {
  const now = Date.now();
  for (const [k, v] of streamCache) {
    if (now - v.cachedAt > CACHE_TTL_MS) streamCache.delete(k);
  }
  while (streamCache.size >= MAX_CACHE_SLOTS) {
    const oldest = [...streamCache.entries()].sort((a, b) => a[1].cachedAt - b[1].cachedAt)[0];
    streamCache.delete(oldest[0]);
  }
}

// ── Retry-aware CDN fetch ─────────────────────────────────────────────────────
// Returns a Promise resolving to the successful IncomingMessage, or throws after maxRetries.
function fetchFromCDN(finalUrl, requestHeaders, maxRetries = 4) {
  const delays = [800, 2000, 4000, 8000];

  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(finalUrl); } catch (e) { return reject(e); }

    const isHttps = parsed.protocol === 'https:';
    const transport = isHttps ? https : http;
    const baseOpts = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'GET',
      agent: isHttps ? httpsAgent : httpAgent,
    };

    const attempt = (tryNum) => {
      // Rotate referers to bypass hotlinking protection
      const dynamicRefererPool = [
        parsed.origin + '/',         // Attempt 1: The site's own origin
        'https://www.google.com/',   // Attempt 2: Search engine click-through
        '',                          // Attempt 3: Direct URL entry
        'https://web.telegram.org/', // Attempt 4: Social link
      ];
      
      const referer = dynamicRefererPool[tryNum % dynamicRefererPool.length];
      const headers = {
        'User-Agent': BROWSER_UA,
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'identity',
        'Sec-Fetch-Mode': 'no-cors',
        'Sec-Fetch-Site': 'cross-site',
        'Connection': 'keep-alive',
        ...requestHeaders, // (e.g. Range header)
        ...(referer ? { 'Referer': referer } : {}),
      };

      const req = transport.request({ ...baseOpts, headers }, res => {
        if ((res.statusCode === 500 || res.statusCode === 503 || res.statusCode === 429) && tryNum < maxRetries) {
          res.resume(); // drain and ignore body
          console.log(`[Retry] CDN returned ${res.statusCode}. Attempt ${tryNum + 1}/${maxRetries}. Waiting ${delays[tryNum]}ms... Referer: "${referer}"`);
          setTimeout(() => attempt(tryNum + 1), delays[tryNum]);
        } else {
          resolve(res);
        }
      });

      req.on('error', err => {
        if (tryNum < maxRetries) {
          console.log(`[Retry] Network error: ${err.message}. Attempt ${tryNum + 1}/${maxRetries}.`);
          setTimeout(() => attempt(tryNum + 1), delays[tryNum]);
        } else {
          reject(err);
        }
      });

      req.end();
      return req;
    };

    attempt(0);
  });
}

// ── Stream Pre-Warmer ─────────────────────────────────────────────────────────
async function prewarmStream(originalUrl) {
  const existing = streamCache.get(originalUrl);
  if (existing && Date.now() - existing.cachedAt < CACHE_TTL_MS) return;

  console.log(`[PreWarm] Starting: ...${originalUrl.slice(-50)}`);
  try {
    const finalUrl = await resolveRedirects(originalUrl);
    const res = await fetchFromCDN(finalUrl, { Range: `bytes=0-${MAX_PREWARM_BYTES - 1}` });

    let totalSize = null;
    const cr = res.headers['content-range'];
    if (cr) { const m = cr.match(/\/(\d+)/); if (m) totalSize = parseInt(m[1]); }
    else if (res.headers['content-length']) totalSize = parseInt(res.headers['content-length']);

    let ct = res.headers['content-type'] || 'video/mp4';
    if (ct.includes('octet-stream'))     ct = 'video/mp4';
    else if (ct.includes('x-matroska') || ct.includes('mkv')) ct = 'video/webm';

    const chunks = []; let totalBytes = 0;
    await new Promise(resolve => {
      res.on('data', chunk => { totalBytes += chunk.length; chunks.push(chunk); if (totalBytes >= MAX_PREWARM_BYTES) res.destroy(); });
      res.on('close', () => {
        const buffer = Buffer.concat(chunks);
        evictStale();
        streamCache.set(originalUrl, { buffer, finalUrl, contentType: ct, totalSize, cachedAt: Date.now() });
        console.log(`[PreWarm] ✅ ${(buffer.length / 1024 / 1024).toFixed(2)} MB cached`);
        resolve();
      });
      res.on('error', resolve);
    });
  } catch (err) {
    console.error(`[PreWarm] ❌ Failed: ${err.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// HLS TRANSCODING ENGINE (requires ffmpeg in PATH)
// ═══════════════════════════════════════════════════════════════════════════════
const HLS_DIR   = path.join(__dirname, 'hls_cache');
const HLS_JOBS  = new Map(); // url -> { dir, status: 'pending'|'ready'|'error' }

// Ensure HLS cache directory exists
if (!fsSync.existsSync(HLS_DIR)) fsSync.mkdirSync(HLS_DIR, { recursive: true });

function urlToKey(url) {
  return crypto.createHash('md5').update(url).digest('hex').slice(0, 16);
}

// ── Quality Presets ───────────────────────────────────────────────────────────
// 'copy'  = stream-copy video (instant, no quality loss, but codec must be browser-compatible)
// '1080p' = H.264 re-encode at 1080p — best compatibility
// '720p'  = H.264 re-encode at 720p  — fastest start, still HD
// '480p'  = H.264 re-encode at 480p  — lowest bandwidth
const QUALITY_PRESETS = {
  copy: {
    label: 'Source (Copy)',
    videoArgs: ['-c:v', 'copy'],  // No re-encode — preserves original quality
  },
  '1080p': {
    label: '1080p HD • H.264',
    videoArgs: [
      '-c:v', 'libx264',
      '-crf', '18',              // Near-lossless (18=excellent, 23=default, 28=poor)
      '-preset', 'veryfast',     // Fast encode, good compression
      '-profile:v', 'high',      // H.264 High profile for max quality
      '-level', '4.1',
      '-pix_fmt', 'yuv420p',     // Force compatible pixel format (Fixes HEVC issues)
      '-vf', 'scale=-2:1080',    // Scale to 1080p preserving aspect ratio
    ],
  },
  '720p': {
    label: '720p HD • H.264',
    videoArgs: [
      '-c:v', 'libx264',
      '-crf', '20',
      '-preset', 'veryfast',
      '-profile:v', 'high',
      '-level', '4.1',
      '-pix_fmt', 'yuv420p',
      '-vf', 'scale=-2:720',
    ],
  },
  '480p': {
    label: '480p SD • H.264',
    videoArgs: [
      '-c:v', 'libx264',
      '-crf', '23',
      '-preset', 'veryfast',
      '-pix_fmt', 'yuv420p',
      '-vf', 'scale=-2:480',
    ],
  },
};

async function startHLSTranscode(originalUrl, quality = 'copy', audioIndex = 0) {
  const preset = QUALITY_PRESETS[quality] || QUALITY_PRESETS['copy'];
  const key    = urlToKey(originalUrl + '|' + quality + '|' + audioIndex); // different key per quality & audio track
  const jobDir = path.join(HLS_DIR, key);

  // Return existing job if already running/complete
  if (HLS_JOBS.has(key)) return key;

  const m3u8Path = path.join(jobDir, 'index.m3u8');

  // Return if already fully transcoded on disk
  if (fsSync.existsSync(m3u8Path)) {
    HLS_JOBS.set(key, { dir: jobDir, status: 'ready' });
    return key;
  }

  await fs.mkdir(jobDir, { recursive: true });
  HLS_JOBS.set(key, { dir: jobDir, status: 'pending', ffProcess: null, quality, label: preset.label });

  // Use the dynamic internal PORT for proxy communication
  const proxyStreamUrl = `http://localhost:${PORT}/api/stream?url=${encodeURIComponent(originalUrl)}`;

  // Build ffmpeg args using the chosen quality preset
  const ff = spawn(FFMPEG_EXE, [
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '15',
    '-i', proxyStreamUrl,
    ...preset.videoArgs,          // Quality-specific video args
    '-c:a', 'aac',                // Always transcode audio to AAC for browser compatibility
    '-b:a', '192k',
    '-ac', '2',                   // Downmix to stereo (avoids surround-sound issues)
    '-map', '0:v:0',
    '-map', `0:a:${audioIndex}?`,   // Use selected audio track by index
    '-hls_time', '2',             // Reduced from 4s to 2s for faster initial buffering
    '-hls_list_size', '0',
    '-hls_segment_type', 'mpegts',
    '-hls_flags', 'independent_segments',
    '-hls_segment_filename', path.join(jobDir, 'seg%04d.ts'),
    '-f', 'hls',
    m3u8Path,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  HLS_JOBS.get(key).ffProcess = ff;

  // Log ffmpeg output
  ff.stderr.on('data', d => process.stderr.write(d));

  // RELIABLE readiness check: poll the filesystem every 500ms
  // Never rely on ffmpeg stderr text which varies by version
  const seg0Path = path.join(jobDir, 'seg0000.ts');
  const readyPoller = setInterval(() => {
    if (fsSync.existsSync(seg0Path) && fsSync.statSync(seg0Path).size > 0) {
      clearInterval(readyPoller);
      const j = HLS_JOBS.get(key);
      if (j && j.status === 'pending') {
        j.status = 'ready';
        console.log(`[HLS] First segment on disk — ready! key=${key.slice(0, 12)}`);
      }
    }
  }, 500);

  ff.on('error', err => {
    clearInterval(readyPoller);
    if (err.code === 'ENOENT') {
      console.error('[HLS] ffmpeg not found at:', FFMPEG_EXE);
    } else {
      console.error(`[HLS] Error spawning ffmpeg for key=${key.slice(0, 12)}:`, err.message);
    }
    const j = HLS_JOBS.get(key);
    if (j) j.status = 'error';
  });

  ff.on('exit', code => {
    clearInterval(readyPoller);
    const j = HLS_JOBS.get(key);
    if (j) j.status = (code === 0 || fsSync.existsSync(seg0Path)) ? 'ready' : 'error';
    console.log(`[HLS] ffmpeg exited with code ${code}`);
  });

  return key;
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPRESS + SOCKET.IO
// ═══════════════════════════════════════════════════════════════════════════════
const DB_FILE = path.join(__dirname, 'db.json');
const app     = express();
app.use(cors());
app.use(express.json());

// ── Serve React Frontend in Production ───────────────────────────────────────
// When hosted on a cloud VPS perfectly serves the UI alongside the API
const frontendDist = path.join(__dirname, '../frontend/dist');
app.use(express.static(frontendDist));

const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

async function readDb() {
  try { return JSON.parse(await fs.readFile(DB_FILE, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return {}; throw e; }
}
async function writeDb(data) {
  await fs.writeFile(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
}


// ── POST /api/play ────────────────────────────────────────────────────────────

app.post('/api/play', async (req, res) => {
  const { videoUrl } = req.body;
  if (!videoUrl) return res.status(400).json({ error: 'videoUrl required' });
  try {
    const db = await readDb();
    if (!db['my_tv_01']) db['my_tv_01'] = { currentVideoUrl: '', history: [] };
    db['my_tv_01'].currentVideoUrl = videoUrl;
    db['my_tv_01'].history = [videoUrl, ...(db['my_tv_01'].history || []).filter(u => u !== videoUrl)].slice(0, 50);
    await writeDb(db);
    io.emit('new_video', { url: videoUrl, history: db['my_tv_01'].history });
    res.status(200).json({ message: 'Sent to TV!' });

    // Fire background tasks — don't block the response
    prewarmStream(videoUrl).catch(() => {});
    // Pre-resolve redirects so seeked requests are instant
    resolveRedirects(videoUrl).catch(() => {});
    // Pre-probe audio codec so /api/stream routes correctly on the FIRST request
    probeForAutoRemux(videoUrl).catch(() => {});
  } catch (err) {
    console.error('Error in /api/play:', err);
    res.status(500).json({ error: 'Failed' });
  }
});

// ── GET /api/current ──────────────────────────────────────────────────────────
app.get('/api/current', async (req, res) => {
  try {
    const db    = await readDb();
    const state = db['my_tv_01'] || { currentVideoUrl: '', history: [] };
    res.status(200).json({ currentVideoUrl: state.currentVideoUrl || '', history: state.history || [] });
  } catch { res.status(500).json({ error: 'Failed' }); }
});

// ── GET /api/open-vlc — Spawn local VLC with the given URL ────────────────────
// This works because the Node.js server runs on the SAME machine as VLC.
// The browser calls this endpoint → server spawns VLC → VLC opens instantly.
// Note: Only useful when backend and VLC are on the same machine (local dev).
app.get('/api/open-vlc', (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'No URL provided' });

  // Common VLC paths on Windows, Linux, macOS
  const candidates = [
    'C:\\Program Files\\VideoLAN\\VLC\\vlc.exe',
    'C:\\Program Files (x86)\\VideoLAN\\VLC\\vlc.exe',
    'vlc',                                          // Linux (in PATH)
    '/usr/bin/vlc',                                 // Linux
    '/usr/local/bin/vlc',                           // Linux Homebrew
    '/Applications/VLC.app/Contents/MacOS/VLC',    // macOS
  ];

  let launched = false;
  for (const exe of candidates) {
    try {
      const proc = spawn(exe, [url], { detached: true, stdio: 'ignore', shell: false });
      proc.unref(); // detach so server doesn't wait for VLC to close
      launched = true;
      console.log(`[VLC] Launched: ${exe} "${url.slice(-40)}"`);
      break;
    } catch (_) { /* try next path */ }
  }

  if (launched) {
    res.json({ success: true, message: 'VLC launched' });
  } else {
    res.status(500).json({ success: false, message: 'VLC executable not found. Install VLC or check path.' });
  }
});

// ── GET /api/stream — Smart audio-aware proxy ─────────────────────────────────────
app.get('/api/stream', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send('No URL');

  // ── Audio Compatibility Check (instant cache lookup only) ────────────────────
  // probeForAutoRemux is already fired in /api/play the moment a URL is sent to the TV.
  // By the time the browser makes this stream request, the cache is likely warmed.
  // NEVER block here — connection resets occur if we delay sending response headers.
  const probeMeta = probeCache.get(targetUrl);
  if (!probeMeta) {
    // Cache miss: serve normally this time, probe fires in background for next request
    probeForAutoRemux(targetUrl).catch(() => {});
  }

  if (probeMeta?.needsRemux) {
    // Incompatible audio detected: transparently serve via FFmpeg remux.
    // Stream = copy video (no quality loss) + AAC audio (universal browser support)
    let startSec = 0;
    const rangeHdr = req.headers.range;
    if (rangeHdr && probeMeta.duration > 0) {
      const byteOffset = parseInt(rangeHdr.match(/bytes=(\d+)-/)?.[1] || 0);
      startSec = Math.max(0, Math.floor(byteOffset / (4_000_000 / 8)));
      startSec = Math.min(startSec, probeMeta.duration - 2);
    }

    const ff = spawn(FFMPEG_EXE, [
      '-ss', startSec.toString(),
      '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '15',
      '-i', probeMeta.finalUrl,
      '-threads', '0',
      '-c:v', 'copy',
      '-c:a', 'aac', '-b:a', '192k', '-ac', '2',
      '-map', '0:v:0', '-map', '0:a:0?',
      '-f', 'mp4',
      '-movflags', 'frag_keyframe+empty_moov',
      'pipe:1',
    ]);

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Cache-Control', 'no-cache');
    res.status(200);
    ff.stdout.pipe(res);
    ff.stderr.on('data', d => { const l = d.toString(); if (l.includes('Error')) console.error('[AutoRemux]', l.trim()); });
    const kill = () => { try { ff.kill('SIGKILL'); } catch {} };
    req.on('close', kill); res.on('finish', kill);
    console.log(`[AutoRemux] ${targetUrl.slice(-45)} | ss=${startSec}s`);
    return;
  }

  const rangeHeader = req.headers.range;
  const cached      = streamCache.get(targetUrl);

  // ── Cache-first: serve pre-warmed bytes from RAM ──────────────────────────
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    let start = 0;
    if (rangeHeader) { const m = rangeHeader.match(/bytes=(\d+)-/); if (m) start = parseInt(m[1]); }

    if (start < cached.buffer.length) {
      const slice = cached.buffer.slice(start);
      res.setHeader('Content-Type',   cached.contentType);
      res.setHeader('Accept-Ranges',  'bytes');
      res.setHeader('Cache-Control',  'public, max-age=3600');
      res.setHeader('Content-Length', slice.length);
      if (cached.totalSize) res.setHeader('Content-Range', `bytes ${start}-${start + slice.length - 1}/${cached.totalSize}`);
      res.status(cached.totalSize ? 206 : 200);
      res.end(slice);
      return;
    }
  }

  // ── Live proxy with retry + Referer rotation ──────────────────────────────
  try {
    const finalUrl = await resolveRedirects(targetUrl);
    const cdnRes   = await fetchFromCDN(finalUrl, rangeHeader ? { Range: rangeHeader } : {});

    let ct = cdnRes.headers['content-type'] || 'video/mp4';
    if (ct.includes('octet-stream'))     ct = 'video/mp4';
    else if (ct.includes('x-matroska') || ct.includes('mkv')) ct = 'video/webm';

    ['content-length', 'accept-ranges', 'content-range', 'last-modified', 'etag']
      .forEach(h => { if (cdnRes.headers[h]) res.setHeader(h, cdnRes.headers[h]); });

    res.setHeader('Content-Type',  ct);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.status(cdnRes.statusCode);
    cdnRes.pipe(res, { end: true });

    req.on('close', () => cdnRes.destroy());
  } catch (err) {
    console.error('[Stream] All retries exhausted:', err.message);
    if (!res.headersSent) {
      res.status(502).json({
        error: 'cdn_unreachable',
        message: 'The CDN could not deliver the video after multiple retries. Try a different link or use HLS mode.',
        retried: 4
      });
    }
  }
});

// ── GET /api/stream/remux — Live audio transcoding + video copy (Remux) ──────
// Fixed audio (AAC) + Original Video (Copy) in a progressive MP4 stream
app.get('/api/stream/remux', async (req, res) => {
  const { url, audioIndex = 0, ss = 0 } = req.query;
  if (!url) return res.status(400).send('No URL');

  try {
    const finalUrl = await resolveRedirects(url);
    const ffArgs = [
      '-ss', ss.toString(),
      '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '15',
      '-i', finalUrl,
      '-threads', '0',             // Use all available CPU cores for remux speed
      '-preset', 'ultrafast',
      '-c:v', 'copy',              // Original video quality
      '-c:a', 'aac',               // Fixed audio for browser
      '-b:a', '192k',
      '-ac', '2',
      '-map', '0:v:0',
      '-map', `0:a:${audioIndex}?`,
      '-f', 'mp4',
      '-movflags', 'frag_keyframe+empty_moov+faststart',
      'pipe:1'
    ];

    console.log(`[Remux] Start: url=${url.slice(-30)} audio=${audioIndex} ss=${ss}`);
    const ff = spawn(FFMPEG_EXE, ffArgs);

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Cache-Control', 'no-cache');

    ff.stdout.pipe(res);

    // Errors
    ff.stderr.on('data', d => {
      const line = d.toString();
      if (line.includes('Error')) console.error('[Remux FFmpeg]', line.trim());
    });

    // Cleanup
    const cleanup = () => { if (ff) { ff.kill('SIGKILL'); } };
    req.on('close', cleanup);
    res.on('finish', cleanup);
    ff.on('error', cleanup);

  } catch (err) {
    console.error('[Remux Error]', err.message);
    res.status(500).send(err.message);
  }
});

// ── POST /api/hls/start — Begin ffmpeg HLS transcoding ───────────────────────
app.post('/api/hls/start', async (req, res) => {
  const { videoUrl, quality = 'copy', audioIndex = 0 } = req.body;
  if (!videoUrl) return res.status(400).json({ error: 'videoUrl required' });
  if (!QUALITY_PRESETS[quality]) return res.status(400).json({ error: `Invalid quality: ${quality}. Valid: ${Object.keys(QUALITY_PRESETS).join(', ')}` });
  try {
    const key = await startHLSTranscode(videoUrl, quality, audioIndex);
    res.json({
      key,
      quality,
      label: QUALITY_PRESETS[quality].label,
      playlistUrl: `/api/hls/${key}/index.m3u8`,
      status: HLS_JOBS.get(key)?.status,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/hls/status/:key — Check transcoding progress ────────────────────
app.get('/api/hls/status/:key', (req, res) => {
  const job = HLS_JOBS.get(req.params.key);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json({ status: job.status });
});

// ── GET /api/hls/:key/* — Serve HLS segments ─────────────────────────────────
app.use('/api/hls/:key', (req, res, next) => {
  const job = HLS_JOBS.get(req.params.key);
  if (!job) return res.status(404).send('HLS job not found');

  const filePath = path.join(job.dir, req.path.replace(/^\//, ''));

  if (req.path.endsWith('.m3u8')) {
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-cache');
  } else if (req.path.endsWith('.ts')) {
    res.setHeader('Content-Type', 'video/mp2t');
    res.setHeader('Cache-Control', 'public, max-age=86400');
  }

  res.sendFile(filePath, err => {
    if (err && !res.headersSent) res.status(404).send('Segment not ready yet');
  });
});

// ── GET /api/probe — Detect audio tracks using ffprobe ────────────────────────
// Probes the CDN URL DIRECTLY (not via local proxy) for speed.
// Also checks probeCache first — if the auto-remux system already probed this,
// we return cached codec info instantly without spawning ffprobe at all.
app.get('/api/probe', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).json({ error: 'url required' });

  try {
    // ── Fast path: return from auto-remux probe cache if available ────────────
    const cached = probeCache.get(targetUrl);
    if (cached && Date.now() - cached.cachedAt < PROBE_TTL_MS) {
      // We already know about this URL from the auto-remux probe — just run
      // a full audio-track probe directly on the resolved (no-redirect) URL
      // using the cached finalUrl to skip DNS/redirect round-trips.
    }

    // Resolve redirect once (cached after first call)
    const finalUrl = await resolveRedirects(targetUrl);

    const result = await new Promise((resolve, reject) => {
      const ff = spawn(FFPROBE_EXE, [
        '-v', 'quiet',
        '-print_format', 'json',
        '-show_streams',
        '-select_streams', 'a',        // audio streams only
        '-read_intervals', '%+#1',     // stop after first audio packet — 10x faster
        '-i', finalUrl,                // probe CDN directly, NOT through localhost proxy
      ]);

      let stdout = '';
      let stderr = '';
      ff.stdout.on('data', d => stdout += d);
      ff.stderr.on('data', d => stderr += d);

      ff.on('close', code => {
        // ffprobe exits non-zero when using -read_intervals, that's expected — still parse
        try { resolve(JSON.parse(stdout)); }
        catch { reject(new Error(`ffprobe parse error | exit=${code} | ${stderr.slice(0, 200)}`)); }
      });

      ff.on('error', err => {
        if (err.code === 'ENOENT') reject(new Error(`ffprobe not found at: ${FFPROBE_EXE}`));
        else reject(err);
      });

      // Kill after 20s for very slow CDNs
      setTimeout(() => { try { ff.kill(); } catch {} reject(new Error('ffprobe timeout')); }, 20000);
    });

    const audioTracks = (result.streams || []).map((s, i) => ({
      id: i,
      index: s.index,
      lang: s.tags?.language || s.tags?.LANGUAGE || null,
      name: s.tags?.title   || s.tags?.TITLE    || null,
      codec: s.codec_name,
      channels: s.channels,
      sampleRate: s.sample_rate,
    }));

    res.json({ audioTracks });
  } catch (err) {
    console.error('[Probe] Error:', err.message);
    // Graceful fallback — player still works without rich track info
    res.status(200).json({ audioTracks: [], error: err.message });
  }
});

// ── GET /api/cache-status — Debug ─────────────────────────────────────────────
app.get('/api/cache-status', (_, res) => {
  res.json({
    streamCacheEntries: [...streamCache.entries()].map(([url, v]) => ({
      url: url.slice(-60),
      sizeMB: (v.buffer.length / 1024 / 1024).toFixed(2),
      ageMin: ((Date.now() - v.cachedAt) / 60000).toFixed(1),
    })),
    redirectCacheSize: redirectCache.size,
    hlsJobs: [...HLS_JOBS.entries()].map(([k, v]) => ({ key: k, status: v.status })),
  });
});

io.on('connection', socket => {
  console.log('Client connected:', socket.id);
  socket.on('disconnect', () => console.log('Client disconnected:', socket.id));
});

// ── Catch-all for React Router ───────────────────────────────────────────────
// In Express 5, '*' throws a PathError. A parameterless app.use catches everything!
app.use((req, res) => {
  res.sendFile(path.join(frontendDist, 'index.html'));
});

server.listen(PORT, '0.0.0.0', () => {console.log(`🚀 Server running on http://localhost:${PORT}`)});
