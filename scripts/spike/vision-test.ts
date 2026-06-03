#!/usr/bin/env ts-node
/**
 * @fileoverview Multi-model vision bake-off runner for the Lemma validation spike.
 *
 * Loads `scripts/spike/fixtures/sample-page.png` (or the rendered.png produced by
 * render-test.ts if that file exists), encodes it as base64, then calls Claude,
 * GPT-4o, and Gemini 1.5 Pro in parallel using the exact system prompt that will
 * be used in production.  Each model's full response is written to a dedicated
 * fixture file and wall-clock latency + token counts are logged.
 *
 * Usage:
 *   npx ts-node scripts/spike/vision-test.ts
 *
 * Required environment variables (skip the corresponding model if absent):
 *   ANTHROPIC_API_KEY   — Claude claude-sonnet-4-6
 *   OPENAI_API_KEY      — GPT-4o
 *   GOOGLE_API_KEY      — Gemini 1.5 Pro
 *   MATHPIX_APP_ID      — Mathpix (optional)
 *   MATHPIX_APP_KEY     — Mathpix (optional)
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── Paths ────────────────────────────────────────────────────────────────────

/** Directory containing spike fixture images and output files. */
const FIXTURES_DIR = join(__dirname, 'fixtures');

/** Preferred input: rendered.png from render-test.ts; fall back to sample-page.png. */
const INPUT_IMAGE_PATH = existsSync(join(FIXTURES_DIR, 'rendered.png'))
  ? join(FIXTURES_DIR, 'rendered.png')
  : join(FIXTURES_DIR, 'sample-page.png');

// ─── System prompt (identical to the production prompt in src/vision/prompt.ts) ──

/**
 * The system prompt sent verbatim to every vision model.
 * Defines the output format: callout convention, math notation, diagram handling,
 * and the mandatory confidence comment.
 */
export const SYSTEM_PROMPT = `You are a faithful transcription assistant for handwritten graph-theory notes.
Your output must be valid GitHub-Flavored Markdown with no prose that is not in
the original notes.

CALLOUT CONVENTION — use EXACTLY these callout types and syntax:
  > [!definition] <Title>
  > <body>

  > [!theorem] <Title>
  > <body>

  > [!proof]
  > <body>

  > [!example] <Title>
  > <body>

  > [!diagram] <Caption>
  > ![fig](./assets/<asset-placeholder>.png)
  > \`\`\`json
  > { "type": "undirected"|"directed"|"weighted",
  >   "vertices": [...],
  >   "edges": [...],
  >   "caption": "<same as callout title>" }
  > \`\`\`

MATH — all inline math: $...$  — all display math: $$...$$
Use LaTeX notation. If you are unsure of a symbol, write [UNCERTAIN: <description>].

DIAGRAMS — for every hand-drawn graph: embed the callout with JSON adjacency.
If a diagram is NOT a graph (e.g. a Venn diagram, flowchart), use the [!diagram]
callout but omit the JSON block and write [NON-GRAPH-DIAGRAM] after the image tag.

CONFIDENCE — at the very end of the output, append a single line:
<!-- confidence: high|medium|low -->
high = all content clear; medium = some ambiguity; low = significant sections unclear.

NEVER invent content not visible in the image. NEVER hallucinate proof steps.
If a section is illegible, write [ILLEGIBLE].`;

/** User-turn template.  Interpolate {pageTitle} and {sectionName} before sending. */
export const USER_PROMPT_TEMPLATE =
  'Please transcribe the following handwritten graph-theory notes page.\n' +
  'Page title: {pageTitle}\nSection: {sectionName}';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Reads an image file from disk and returns it as a base64-encoded string.
 *
 * @param imagePath - Absolute or relative path to the image file.
 * @returns Base64-encoded image bytes.
 */
export function encodeImageToBase64(imagePath: string): string {
  return readFileSync(imagePath).toString('base64');
}

/**
 * Writes a model's response string to `fixtures/<modelName>-output.md`.
 *
 * @param modelName - Identifier used as the filename prefix (e.g. `claude-sonnet-4-6`).
 * @param content   - Raw Markdown response from the model.
 */
export function writeModelOutput(modelName: string, content: string): void {
  const outPath = join(FIXTURES_DIR, `${modelName}-output.md`);
  writeFileSync(outPath, content, 'utf-8');
  console.log(`[vision-test] Wrote output: ${outPath}`);
}

/**
 * Extracts the token count from a known response shape, returning 0 if the
 * field is absent (so callers don't have to guard).
 *
 * @param usage - Usage object from any of the SDK response types.
 */
export function extractTokenCount(usage: Record<string, unknown> | undefined): number {
  if (!usage) return 0;
  const total = (usage['total_tokens'] as number | undefined)
    ?? ((usage['input_tokens'] as number | undefined) ?? 0)
      + ((usage['output_tokens'] as number | undefined) ?? 0);
  return total;
}

// ─── Model callers ────────────────────────────────────────────────────────────

/**
 * Calls Claude claude-sonnet-4-6 via the Anthropic SDK and returns the raw response text.
 *
 * @param imageBase64 - Base64-encoded JPEG/PNG image.
 * @returns Object containing the response text, token usage, and wall-clock latency.
 */
export async function callClaude(
  imageBase64: string,
): Promise<{ text: string; tokens: number; latencyMs: number }> {
  const Anthropic = (await import('@anthropic-ai/sdk')).default;
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const start = Date.now();
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: imageBase64,
            },
          },
          {
            type: 'text',
            text: USER_PROMPT_TEMPLATE
              .replace('{pageTitle}', 'Spike Test Page')
              .replace('{sectionName}', 'Graph Theory'),
          },
        ],
      },
    ],
  });

  const latencyMs = Date.now() - start;
  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => (b as { type: 'text'; text: string }).text)
    .join('');

  const tokens = extractTokenCount(response.usage as unknown as Record<string, unknown>);
  return { text, tokens, latencyMs };
}

/**
 * Calls GPT-4o via the OpenAI SDK and returns the raw response text.
 *
 * @param imageBase64 - Base64-encoded JPEG/PNG image.
 * @returns Object containing the response text, token usage, and wall-clock latency.
 */
export async function callGpt4o(
  imageBase64: string,
): Promise<{ text: string; tokens: number; latencyMs: number }> {
  const { OpenAI } = await import('openai');
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const start = Date.now();
  const response = await client.chat.completions.create({
    model: 'gpt-4o',
    max_tokens: 4096,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: `data:image/png;base64,${imageBase64}` },
          },
          {
            type: 'text',
            text: USER_PROMPT_TEMPLATE
              .replace('{pageTitle}', 'Spike Test Page')
              .replace('{sectionName}', 'Graph Theory'),
          },
        ],
      },
    ],
  });

  const latencyMs = Date.now() - start;
  const text = response.choices[0]?.message?.content ?? '';
  const tokens = extractTokenCount(response.usage as unknown as Record<string, unknown>);
  return { text, tokens, latencyMs };
}

/**
 * Calls Gemini 1.5 Pro via the Google Generative AI SDK and returns the response text.
 *
 * @param imageBase64 - Base64-encoded JPEG/PNG image.
 * @returns Object containing the response text, token usage, and wall-clock latency.
 */
export async function callGemini(
  imageBase64: string,
): Promise<{ text: string; tokens: number; latencyMs: number }> {
  const { GoogleGenerativeAI } = await import('@google/generative-ai');
  const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY ?? '');
  const model = genAI.getGenerativeModel({
    model: 'gemini-1.5-pro',
    systemInstruction: SYSTEM_PROMPT,
  });

  const start = Date.now();
  const result = await model.generateContent([
    {
      inlineData: { data: imageBase64, mimeType: 'image/png' },
    },
    USER_PROMPT_TEMPLATE
      .replace('{pageTitle}', 'Spike Test Page')
      .replace('{sectionName}', 'Graph Theory'),
  ]);

  const latencyMs = Date.now() - start;
  const response = result.response;
  const text = response.text();
  const usageMeta = response.usageMetadata;
  const tokens = usageMeta
    ? (usageMeta.totalTokenCount ?? 0)
    : 0;

  return { text, tokens, latencyMs };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

/**
 * Runs the multi-model bake-off:
 *  1. Loads and base64-encodes the test fixture image.
 *  2. Fires all available model calls in parallel (skips any with missing API key).
 *  3. Writes each model's response to a fixture file.
 *  4. Logs latency and token counts for each call.
 */
async function main(): Promise<void> {
  console.log(`[vision-test] Loading image: ${INPUT_IMAGE_PATH}`);
  const imageBase64 = encodeImageToBase64(INPUT_IMAGE_PATH);
  console.log(
    `[vision-test] Image encoded (${Math.round(imageBase64.length / 1024)} KB base64)`,
  );

  type ModelResult = {
    name: string;
    text: string;
    tokens: number;
    latencyMs: number;
  };

  const tasks: Array<Promise<ModelResult | null>> = [];

  // Claude claude-sonnet-4-6
  if (process.env.ANTHROPIC_API_KEY) {
    tasks.push(
      callClaude(imageBase64)
        .then((r) => ({ name: 'claude-sonnet-4-6', ...r }))
        .catch((err: unknown) => {
          console.error('[vision-test] Claude call failed:', err);
          return null;
        }),
    );
  } else {
    console.warn('[vision-test] ANTHROPIC_API_KEY not set — skipping Claude');
    tasks.push(Promise.resolve(null));
  }

  // GPT-4o
  if (process.env.OPENAI_API_KEY) {
    tasks.push(
      callGpt4o(imageBase64)
        .then((r) => ({ name: 'gpt-4o', ...r }))
        .catch((err: unknown) => {
          console.error('[vision-test] GPT-4o call failed:', err);
          return null;
        }),
    );
  } else {
    console.warn('[vision-test] OPENAI_API_KEY not set — skipping GPT-4o');
    tasks.push(Promise.resolve(null));
  }

  // Gemini 1.5 Pro
  if (process.env.GOOGLE_API_KEY) {
    tasks.push(
      callGemini(imageBase64)
        .then((r) => ({ name: 'gemini-1.5-pro', ...r }))
        .catch((err: unknown) => {
          console.error('[vision-test] Gemini call failed:', err);
          return null;
        }),
    );
  } else {
    console.warn('[vision-test] GOOGLE_API_KEY not set — skipping Gemini');
    tasks.push(Promise.resolve(null));
  }

  const results = await Promise.all(tasks);

  let successCount = 0;
  for (const result of results) {
    if (!result) continue;
    writeModelOutput(result.name, result.text);
    console.log(
      `[vision-test] ${result.name}: ${result.tokens} tokens, ${result.latencyMs}ms`,
    );
    successCount++;
  }

  if (successCount === 0) {
    console.error(
      '[vision-test] No models ran. Set at least one of ' +
      'ANTHROPIC_API_KEY, OPENAI_API_KEY, or GOOGLE_API_KEY.',
    );
    process.exit(1);
  }

  console.log(`[vision-test] Done — ${successCount} model(s) ran successfully.`);
}

// Only run main() when executed directly (not when imported by tests)
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error('[vision-test] Fatal error:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
