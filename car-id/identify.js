import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import * as z from 'zod/v4';

// Claude Opus 5. Thinking is on by default on this model and max_tokens caps
// thinking + output together, so leave generous headroom. Do not send
// temperature / top_p / top_k / budget_tokens — all return 400 on Opus 5.
const MODEL = 'claude-opus-5';
const MAX_TOKENS = 16000;

/**
 * Every field is required and nullable rather than optional: structured outputs
 * needs `required` to list all properties, so "absent" is expressed as null.
 */
const CarIdentification = z.object({
  is_vehicle: z
    .boolean()
    .describe('False if the image does not show a car, truck, van, or similar road vehicle.'),
  identification: z
    .object({
      brand: z.string().nullable().describe('Manufacturer, e.g. "Toyota".'),
      model: z.string().nullable().describe('Model name, e.g. "Corolla".'),
      generation: z
        .string()
        .nullable()
        .describe('Generation or chassis code if identifiable, e.g. "E210" or "Mk8".'),
      year_range: z
        .string()
        .nullable()
        .describe('Production years this specific facelift/generation covers, e.g. "2019-2024".'),
      body_style: z.string().nullable().describe('e.g. "5-door hatchback", "crew-cab pickup".'),
      trim_or_variant: z
        .string()
        .nullable()
        .describe('Trim level or variant if badging or equipment reveals it.'),
      market_region: z
        .string()
        .nullable()
        .describe('Market this specification appears to be sold in, if the styling indicates one.'),
      confidence: z.enum(['high', 'medium', 'low']),
    })
    .describe('The primary identification.'),
  exterior: z.object({
    color: z.string().nullable(),
    wheels: z.string().nullable().describe('Design, apparent size, and finish.'),
    lighting: z.string().nullable().describe('Headlight and taillight technology and signature.'),
    badging: z.string().nullable().describe('Any badges, lettering, or emblems actually visible.'),
    distinguishing_features: z
      .array(z.string())
      .describe('Visible exterior features: body kit, roof rails, spoiler, trim, glass, condition.'),
  }),
  powertrain: z.object({
    likely_engine_options: z
      .array(z.string())
      .describe('Engines offered for this model/generation. Inference unless a badge states it.'),
    drivetrain: z.string().nullable().describe('FWD / RWD / AWD, and how you can tell.'),
    fuel_type: z.string().nullable().describe('Petrol, diesel, hybrid, EV.'),
    note: z
      .string()
      .nullable()
      .describe('State plainly how much of this is read from the car vs inferred from the model.'),
  }),
  interior: z.object({
    visible: z.boolean(),
    notes: z.string().nullable().describe('Only describe the interior if it is actually visible.'),
  }),
  identification_cues: z
    .array(
      z.object({
        cue: z.string().describe('A specific visual detail in the photo.'),
        what_it_indicates: z.string().describe('What that detail narrows the identification to.'),
      }),
    )
    .describe('The visual evidence behind the identification, most decisive first.'),
  alternatives: z
    .array(
      z.object({
        brand: z.string(),
        model: z.string(),
        why_not_chosen: z.string(),
      }),
    )
    .describe('Other plausible matches and what rules each one out. Empty if confidence is high.'),
  caveats: z
    .string()
    .nullable()
    .describe('What the photo does not let you determine: angle, lighting, occlusion, crop.'),
});

const SYSTEM_PROMPT = `You identify road vehicles from photographs.

Separate what you SEE from what you INFER, and never blur the two:
- Body shape, badges, lights, wheels, and trim are observations. Report them as seen.
- Engine options, drivetrain, and market are almost always inferred from the identified
  model and generation, not read off the car. Say so in powertrain.note.

Rules:
- Give a year RANGE covering the generation or facelift, never a single year, unless a
  visible detail genuinely pins one model year.
- Base identification on concrete visual cues and list them in identification_cues, most
  decisive first. A cue is a specific detail ("split upper grille with vertical slats"),
  not a restatement of the conclusion.
- If the photo is partial, dark, distant, badge-free, or the car is heavily modified, set
  confidence to medium or low and populate alternatives. A confident wrong answer is worse
  than an honest narrow one.
- Only describe the interior if it is actually visible through glass or an open door.
- If the image contains no road vehicle, set is_vehicle to false and leave the rest null
  or empty.`;

const USER_PROMPT =
  'Identify this vehicle and describe its features. Fill in every field you can support ' +
  'from the image; use null or an empty list for anything the photo does not show.';

let client = null;
function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) {
    const err = new Error(
      'ANTHROPIC_API_KEY is not configured. Copy .env.example to .env and add your key.',
    );
    err.statusCode = 500;
    err.code = 'no_api_key';
    throw err;
  }
  // Constructed lazily so the server boots (and /api/health answers) without a key.
  client ??= new Anthropic();
  return client;
}

/**
 * @param {string} imageBase64 - raw base64, no data: URL prefix
 * @param {string} mediaType   - image/jpeg | image/png | image/gif | image/webp
 */
export async function identifyCar(imageBase64, mediaType) {
  let message;
  try {
    message = await getClient().messages.parse({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      output_config: { format: zodOutputFormat(CarIdentification) },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
            { type: 'text', text: USER_PROMPT },
          ],
        },
      ],
    });
  } catch (error) {
    throw mapApiError(error);
  }

  // Opus 5's safety classifiers decline with HTTP 200 — check before reading content.
  if (message.stop_reason === 'refusal') {
    const err = new Error(
      'Claude declined to analyze this image' +
        (message.stop_details?.category ? ` (${message.stop_details.category})` : '') +
        '. Try a different photo.',
    );
    err.statusCode = 422;
    err.code = 'refusal';
    throw err;
  }

  if (message.stop_reason === 'max_tokens') {
    const err = new Error('The response was cut off before it finished. Try again.');
    err.statusCode = 502;
    err.code = 'max_tokens';
    throw err;
  }

  if (!message.parsed_output) {
    const err = new Error('Claude returned a response that did not match the expected format.');
    err.statusCode = 502;
    err.code = 'unparseable';
    throw err;
  }

  return { result: message.parsed_output, usage: message.usage };
}

/** Most-specific-first chain over the SDK's typed errors — never string matching. */
function mapApiError(error) {
  if (error?.statusCode) return error; // already ours (e.g. no_api_key)

  let message;
  let statusCode;
  let code;

  if (error instanceof Anthropic.AuthenticationError) {
    message = 'Your ANTHROPIC_API_KEY was rejected. Check the key in .env.';
    statusCode = 401;
    code = 'auth';
  } else if (error instanceof Anthropic.PermissionDeniedError) {
    message = 'This API key does not have access to ' + MODEL + '.';
    statusCode = 403;
    code = 'permission';
  } else if (error instanceof Anthropic.NotFoundError) {
    message = 'Model ' + MODEL + ' was not found for this account.';
    statusCode = 404;
    code = 'not_found';
  } else if (error instanceof Anthropic.RateLimitError) {
    message = 'Rate limited by the Anthropic API. Wait a moment and try again.';
    statusCode = 429;
    code = 'rate_limit';
  } else if (error instanceof Anthropic.APIConnectionError) {
    message = 'Could not reach the Anthropic API. Check your network connection.';
    statusCode = 503;
    code = 'connection';
  } else if (error instanceof Anthropic.APIError) {
    message = 'The Anthropic API returned an error: ' + (error.message || 'unknown');
    statusCode = error.status >= 500 ? 502 : 400;
    code = 'api_error';
  } else {
    message = 'Unexpected error: ' + (error?.message || String(error));
    statusCode = 500;
    code = 'unknown';
  }

  const mapped = new Error(message);
  mapped.statusCode = statusCode;
  mapped.code = code;
  mapped.cause = error;
  return mapped;
}

export const __testing = { CarIdentification, MODEL };
