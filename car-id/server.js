import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { identifyCar } from './identify.js';

const here = path.dirname(fileURLToPath(import.meta.url));

// Minimal .env loader — avoids a dependency for one file of KEY=value lines.
loadDotEnv(path.join(here, '.env'));

const PORT = process.env.PORT || 3000;
const ALLOWED_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

const app = express();
// Base64 inflates by ~33%, so the JSON body limit sits above the raw image cap.
app.use(express.json({ limit: '24mb' }));
app.use(express.static(path.join(here, 'public')));

app.get('/api/health', (req, res) => {
  res.json({ ok: true, keyConfigured: Boolean(process.env.ANTHROPIC_API_KEY) });
});

app.post('/api/identify', async (req, res) => {
  const { imageBase64, mediaType } = req.body ?? {};

  if (typeof imageBase64 !== 'string' || imageBase64.length === 0) {
    return res.status(400).json({ error: 'No image was uploaded.', code: 'no_image' });
  }
  if (!ALLOWED_MEDIA_TYPES.has(mediaType)) {
    return res.status(400).json({
      error: `Unsupported image type. Use JPEG, PNG, GIF, or WebP.`,
      code: 'bad_media_type',
    });
  }
  // base64 length * 3/4 approximates the decoded byte count.
  if (imageBase64.length * 0.75 > MAX_IMAGE_BYTES) {
    return res.status(413).json({ error: 'That image is too large.', code: 'too_large' });
  }

  try {
    const { result, usage } = await identifyCar(imageBase64, mediaType);
    res.json({ result, usage });
  } catch (error) {
    const status = error.statusCode || 500;
    if (status >= 500) console.error('[identify]', error.code || '', error.message);
    res.status(status).json({ error: error.message, code: error.code || 'unknown' });
  }
});

// JSON body over the limit surfaces here rather than as an HTML error page.
app.use((error, req, res, next) => {
  if (error?.type === 'entity.too.large') {
    return res.status(413).json({ error: 'That image is too large.', code: 'too_large' });
  }
  if (error) {
    console.error('[server]', error.message);
    return res.status(500).json({ error: 'Server error.', code: 'server_error' });
  }
  next();
});

app.listen(PORT, () => {
  console.log(`car-id listening on http://localhost:${PORT}`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('WARNING: ANTHROPIC_API_KEY is not set — identification requests will fail.');
    console.warn('         Copy .env.example to .env and add your key.');
  }
});

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}
