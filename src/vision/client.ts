/**
 * Vision LLM client for the Lemma pipeline.
 *
 * Wraps the Anthropic SDK to send rendered page images to a configurable
 * Claude vision model. Handles retries on transient errors, logs wall-clock
 * latency and token counts, and provides a rough cost estimate per call.
 *
 * Model selection
 * ───────────────
 * The active model is read from the VISION_MODEL environment variable,
 * defaulting to 'claude-sonnet-4-6'. Any Claude model that supports
 * vision (image input) and produces at most 4096 output tokens is compatible.
 *
 * Retry behaviour
 * ───────────────
 * API errors with HTTP status 429 (rate-limited) or 5xx (server-side) are
 * retryable. The client attempts the call up to MAX_RETRIES additional times
 * (total MAX_RETRIES + 1 attempts). Non-retryable errors (4xx other than 429)
 * are thrown immediately without retrying.
 *
 * Cost estimation
 * ───────────────
 * Approximate per-call cost is logged to stderr using hardcoded price
 * constants (USD per million tokens). These are intentionally rough — they
 * lag actual pricing changes and should be used only as operational guidance,
 * not for billing.
 */

import Anthropic from '@anthropic-ai/sdk';
import { SYSTEM_PROMPT, USER_PROMPT_TEMPLATE } from './prompt.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default vision model when VISION_MODEL env var is not set. */
const DEFAULT_MODEL = 'claude-sonnet-4-6';

/** Maximum output tokens per API call. */
const MAX_TOKENS = 4096;

/** Maximum number of retry attempts after the initial call (total = MAX_RETRIES + 1). */
const MAX_RETRIES = 3;

/** Base delay in ms for the first retry backoff interval. */
const BACKOFF_BASE_MS = 500;

/** Maximum delay cap in ms regardless of attempt count. */
const BACKOFF_MAX_MS = 10_000;

/**
 * Approximate model pricing in USD per million tokens (input / output).
 * Hardcoded as a coarse operational guide — not for billing.
 */
const MODEL_COSTS: Record<string, { input: number; output: number }> = {
  'claude-sonnet-4-6': { input: 3.0, output: 15.0 },
  'claude-haiku-4-5-20251001': { input: 0.8, output: 4.0 },
  'claude-opus-4-8': { input: 15.0, output: 75.0 },
};

// ---------------------------------------------------------------------------
// VisionError
// ---------------------------------------------------------------------------

/**
 * Thrown when the vision API call fails after all retry attempts, or
 * immediately when the failure is not retryable.
 */
export class VisionError extends Error {
  /** Model identifier that produced the error. */
  readonly model: string;
  /** HTTP status code returned by the API (0 if no HTTP response was received). */
  readonly httpStatus: number;
  /** Whether this error could have been retried (true for 429 and 5xx). */
  readonly retryable: boolean;

  /**
   * @param message    - Human-readable error description.
   * @param model      - Model identifier (e.g. 'claude-sonnet-4-6').
   * @param httpStatus - HTTP status code from the API response (0 if unknown).
   */
  constructor(message: string, model: string, httpStatus: number) {
    super(message);
    this.name = 'VisionError';
    this.model = model;
    this.httpStatus = httpStatus;
    this.retryable = httpStatus === 429 || (httpStatus >= 500 && httpStatus < 600);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Computes a bounded exponential backoff delay with ±50 % random jitter.
 * `attempt` is zero-indexed (0 = first retry).
 */
function backoffDelay(attempt: number): number {
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * Math.pow(2, attempt));
  const jitter = base * 0.5 * (Math.random() * 2 - 1);
  return Math.max(0, base + jitter);
}

/**
 * Returns true when the thrown value has a numeric `status` property.
 * Used to detect HTTP-status errors from the Anthropic SDK without depending
 * on the exact error class (improves testability via duck-typing).
 */
function hasHttpStatus(err: unknown): err is { status: number; message: string } {
  return (
    typeof err === 'object' &&
    err !== null &&
    'status' in err &&
    typeof (err as Record<string, unknown>).status === 'number'
  );
}

/**
 * Estimates the USD cost for a single API call given token counts.
 * Falls back to the default model's pricing when the model is unknown.
 *
 * @param model        - Model identifier string.
 * @param inputTokens  - Number of input tokens billed.
 * @param outputTokens - Number of output tokens billed.
 * @returns Estimated cost in USD.
 */
function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const prices = MODEL_COSTS[model] ?? MODEL_COSTS[DEFAULT_MODEL];
  return (inputTokens / 1_000_000) * prices.input + (outputTokens / 1_000_000) * prices.output;
}

// ---------------------------------------------------------------------------
// VisionClient
// ---------------------------------------------------------------------------

/**
 * Client for sending page images to the chosen vision model and receiving
 * structured Markdown transcription responses.
 *
 * Instantiate once per pipeline run. The Anthropic SDK client and model name
 * are resolved from environment variables at construction time.
 */
export class VisionClient {
  private readonly anthropic: Anthropic;
  private readonly model: string;

  /** Creates a VisionClient reading VISION_MODEL and ANTHROPIC_API_KEY from the environment. */
  constructor() {
    this.model = process.env.VISION_MODEL ?? DEFAULT_MODEL;
    this.anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }

  /**
   * Sends a base64-encoded JPEG image and the system + user prompts to the
   * configured vision model and returns the raw model response string.
   *
   * Retries up to {@link MAX_RETRIES} times on retryable errors (HTTP 429 or
   * 5xx). Logs token counts, wall-clock latency, and estimated cost to stderr
   * on each successful call.
   *
   * @param imageBase64  - Base64-encoded JPEG image of the rendered page.
   * @param pageTitle    - Page title injected into the user prompt template.
   * @param sectionName  - Section name injected into the user prompt template.
   * @returns Raw model response string (full Markdown including confidence comment).
   * @throws {@link VisionError} when the API call fails after all retries.
   */
  async convert(imageBase64: string, pageTitle: string, sectionName: string): Promise<string> {
    const userText = USER_PROMPT_TEMPLATE.replace('{{pageTitle}}', pageTitle).replace(
      '{{sectionName}}',
      sectionName,
    );

    console.log(`[vision] sending page to ${this.model}`);
    const start = Date.now();

    let lastError: VisionError | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await this.anthropic.messages.create({
          model: this.model,
          max_tokens: MAX_TOKENS,
          system: SYSTEM_PROMPT,
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: 'image/jpeg',
                    data: imageBase64,
                  },
                },
                { type: 'text', text: userText },
              ],
            },
          ],
        });

        const elapsedMs = Date.now() - start;
        const inputTokens = response.usage.input_tokens;
        const outputTokens = response.usage.output_tokens;
        const totalTokens = inputTokens + outputTokens;
        const costUsd = estimateCost(this.model, inputTokens, outputTokens);

        console.log(
          `[vision] received ${totalTokens} tokens in ${elapsedMs}ms ` +
            `(est. $${costUsd.toFixed(4)})`,
        );

        const textBlock = response.content.find(
          (b): b is { type: 'text'; text: string } => b.type === 'text',
        );
        if (!textBlock) {
          throw new VisionError(
            'Unexpected non-text response block from vision model',
            this.model,
            0,
          );
        }

        return textBlock.text;
      } catch (err) {
        if (err instanceof VisionError) {
          throw err;
        }

        if (hasHttpStatus(err)) {
          const status = err.status;
          const retryable = status === 429 || (status >= 500 && status < 600);

          if (!retryable) {
            throw new VisionError(
              `Vision API error (HTTP ${status}): ${err.message}`,
              this.model,
              status,
            );
          }

          lastError = new VisionError(
            `Vision API error (HTTP ${status}): ${err.message}`,
            this.model,
            status,
          );

          if (attempt < MAX_RETRIES) {
            await new Promise<void>((resolve) =>
              setTimeout(resolve, backoffDelay(attempt)),
            );
            continue;
          }
        } else {
          throw new VisionError(
            err instanceof Error ? err.message : String(err),
            this.model,
            0,
          );
        }
      }
    }

    throw (
      lastError ??
      new VisionError(`Vision API call failed after ${MAX_RETRIES} retries`, this.model, 0)
    );
  }
}
