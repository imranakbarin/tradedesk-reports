/**
 * Exercises the server without needing a real photo or a live model call.
 * Asserts the request pipeline, validation, and error mapping behave.
 *
 *   node smoke-test.mjs            # against http://localhost:3000
 *   BASE=http://host:port node smoke-test.mjs
 */
const BASE = process.env.BASE || 'http://localhost:3000';

// Smallest valid JPEG the canvas/decoder path will accept (1x1, red).
const TINY_JPEG_BASE64 =
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
  'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
  'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${name}`);
    passed++;
  } else {
    console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`);
    failed++;
  }
}

async function post(body) {
  const res = await fetch(`${BASE}/api/identify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

console.log(`car-id smoke test → ${BASE}\n`);

// --- health ---
let health;
try {
  health = await (await fetch(`${BASE}/api/health`)).json();
} catch {
  console.error(`Could not reach ${BASE}. Start the server first: npm start`);
  process.exit(1);
}
check('GET /api/health responds ok', health?.ok === true);
check('health reports key configuration', typeof health?.keyConfigured === 'boolean');
console.log(`  (API key configured: ${health.keyConfigured})\n`);

// --- static UI ---
const page = await fetch(BASE);
const html = await page.text();
check('GET / serves the UI', page.status === 200 && html.includes('Car ID'));

// --- validation ---
let r = await post({});
check('missing image is rejected as 400', r.status === 400, `got ${r.status}`);
check('missing image has code no_image', r.json?.code === 'no_image');

r = await post({ imageBase64: TINY_JPEG_BASE64, mediaType: 'application/pdf' });
check('bad media type is rejected as 400', r.status === 400, `got ${r.status}`);
check('bad media type has code bad_media_type', r.json?.code === 'bad_media_type');

r = await post({ imageBase64: 'A'.repeat(20 * 1024 * 1024), mediaType: 'image/jpeg' });
check('oversized image is rejected as 413', r.status === 413, `got ${r.status}`);

// --- identification path ---
console.log('\n  Posting a valid image to /api/identify…');
r = await post({ imageBase64: TINY_JPEG_BASE64, mediaType: 'image/jpeg' });

if (!health.keyConfigured) {
  check('unkeyed server fails cleanly, not with a stack trace', r.status === 500, `got ${r.status}`);
  check('unkeyed error code is no_api_key', r.json?.code === 'no_api_key', JSON.stringify(r.json));
  check(
    'unkeyed error message explains the fix',
    typeof r.json?.error === 'string' && r.json.error.includes('.env'),
  );
} else {
  // With a key, a 1x1 image is a real call: expect either a well-formed card
  // (is_vehicle false) or a clean, mapped API error — never an unhandled throw.
  if (r.status === 200) {
    const result = r.json?.result;
    check('response has a result object', !!result);
    check('result has is_vehicle boolean', typeof result?.is_vehicle === 'boolean');
    check('result has identification object', typeof result?.identification === 'object');
    check('result has identification_cues array', Array.isArray(result?.identification_cues));
    check('result has exterior object', typeof result?.exterior === 'object');
    check('usage is reported', typeof r.json?.usage?.input_tokens === 'number');
    console.log(`  (is_vehicle: ${result?.is_vehicle} — expected false for a 1x1 image)`);
  } else {
    check(
      'error response is mapped, with a message and code',
      typeof r.json?.error === 'string' && typeof r.json?.code === 'string',
      JSON.stringify(r.json),
    );
    console.log(`  (server returned ${r.status}: ${r.json?.error})`);
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
