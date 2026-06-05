/**
 * Unit tests for src/vision/client.ts.
 *
 * The @anthropic-ai/sdk module is fully mocked so that no real API calls are
 * made. A hoisted `mockCreate` spy controls what the mock messages.create()
 * returns or throws in each test.
 *
 * Coverage:
 *   - VisionClient.convert passes the configured model and SYSTEM_PROMPT.
 *   - VisionClient.convert retries up to MAX_RETRIES times on HTTP 429.
 *   - VisionClient.convert throws VisionError after exhausting all retries.
 *   - VisionClient.convert propagates non-retryable 4xx errors immediately.
 *   - VisionClient.convert logs token count and timing to stdout.
 *   - VisionError carries correct model, httpStatus, and retryable fields.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoist mock functions so they can be used inside vi.mock factories
// ---------------------------------------------------------------------------

const mockCreate = vi.hoisted(() => vi.fn());

// ---------------------------------------------------------------------------
// Mock @anthropic-ai/sdk — replaces the default export (Anthropic class)
// ---------------------------------------------------------------------------

/**
 * Minimal stand-in for Anthropic.APIStatusError so tests can throw
 * an object that has a numeric `status` property without importing the
 * real SDK error class.
 */
class FakeApiStatusError extends Error {
  readonly status: number;

  constructor(status: number, message = `HTTP ${status}`) {
    super(message);
    this.name = 'APIStatusError';
    this.status = status;
  }
}

vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = { create: mockCreate };
  },
}));

// ---------------------------------------------------------------------------
// Imports (after mocks, so they receive mocked modules)
// ---------------------------------------------------------------------------

import { VisionClient, VisionError } from '../../src/vision/client.js';
import { SYSTEM_PROMPT } from '../../src/vision/prompt.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** Minimal successful response shape matching the Anthropic SDK return type. */
function makeSuccessResponse(text = '> [!definition] Test\n<!-- confidence: high -->') {
  return {
    content: [{ type: 'text', text }],
    usage: { input_tokens: 100, output_tokens: 200 },
    model: 'claude-sonnet-4-6',
  };
}

/** Creates a fake API status error with the given HTTP status code. */
function makeApiError(status: number): FakeApiStatusError {
  return new FakeApiStatusError(status);
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let savedVisionModel: string | undefined;
let savedApiKey: string | undefined;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  savedVisionModel = process.env.VISION_MODEL;
  savedApiKey = process.env.ANTHROPIC_API_KEY;

  process.env.VISION_MODEL = 'claude-sonnet-4-6';
  process.env.ANTHROPIC_API_KEY = 'test-api-key';

  mockCreate.mockReset();
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  if (savedVisionModel === undefined) {
    delete process.env.VISION_MODEL;
  } else {
    process.env.VISION_MODEL = savedVisionModel;
  }
  if (savedApiKey === undefined) {
    delete process.env.ANTHROPIC_API_KEY;
  } else {
    process.env.ANTHROPIC_API_KEY = savedApiKey;
  }
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// VisionClient.convert — core behaviour
// ---------------------------------------------------------------------------

describe('VisionClient.convert', () => {
  it('calls the Anthropic SDK messages.create with the configured model', async () => {
    mockCreate.mockResolvedValue(makeSuccessResponse());

    const client = new VisionClient();
    await client.convert('base64data', 'Test Page', 'Graph Theory');

    expect(mockCreate).toHaveBeenCalledOnce();
    const [callArg] = mockCreate.mock.calls[0] as [{ model: string }];
    expect(callArg.model).toBe(process.env.VISION_MODEL);
  });

  it('includes SYSTEM_PROMPT in the system field of the SDK call', async () => {
    mockCreate.mockResolvedValue(makeSuccessResponse());

    const client = new VisionClient();
    await client.convert('base64data', 'Test Page', 'Graph Theory');

    const [callArg] = mockCreate.mock.calls[0] as [{ system: string }];
    expect(callArg.system).toBe(SYSTEM_PROMPT);
  });

  it('interpolates pageTitle and sectionName into the user message', async () => {
    mockCreate.mockResolvedValue(makeSuccessResponse());

    const client = new VisionClient();
    await client.convert('base64data', 'My Title', 'My Section');

    const [callArg] = mockCreate.mock.calls[0] as [
      { messages: Array<{ content: Array<{ type: string; text?: string }> }> },
    ];
    const textBlock = callArg.messages[0].content.find((b) => b.type === 'text');
    expect(textBlock?.text).toContain('My Title');
    expect(textBlock?.text).toContain('My Section');
  });

  it('includes the base64 image as an image content block', async () => {
    mockCreate.mockResolvedValue(makeSuccessResponse());

    const client = new VisionClient();
    await client.convert('mybase64', 'Title', 'Section');

    const [callArg] = mockCreate.mock.calls[0] as [
      {
        messages: Array<{
          content: Array<{ type: string; source?: { type: string; data: string } }>;
        }>;
      },
    ];
    const imageBlock = callArg.messages[0].content.find((b) => b.type === 'image');
    expect(imageBlock?.source?.data).toBe('mybase64');
  });

  it('returns the raw text response string from the model', async () => {
    const expected = '> [!definition] Test\n<!-- confidence: high -->';
    mockCreate.mockResolvedValue(makeSuccessResponse(expected));

    const client = new VisionClient();
    const result = await client.convert('base64', 'Title', 'Section');

    expect(result).toBe(expected);
  });

  it('logs a line containing the model name before the API call', async () => {
    mockCreate.mockResolvedValue(makeSuccessResponse());

    const client = new VisionClient();
    await client.convert('base64', 'Title', 'Section');

    const logOutput = logSpy.mock.calls.flat().join(' ');
    expect(logOutput).toContain('[vision] sending page to');
    expect(logOutput).toContain('claude-sonnet-4-6');
  });

  it('logs token count and timing after a successful call', async () => {
    mockCreate.mockResolvedValue(makeSuccessResponse());

    const client = new VisionClient();
    await client.convert('base64', 'Title', 'Section');

    const logOutput = logSpy.mock.calls.flat().join(' ');
    expect(logOutput).toMatch(/\[vision\] received \d+ tokens in \d+ms/);
  });
});

// ---------------------------------------------------------------------------
// Retry behaviour
// ---------------------------------------------------------------------------

describe('VisionClient.convert — retry on 429', () => {
  it('retries on HTTP 429 and succeeds when a later attempt returns 200', async () => {
    mockCreate
      .mockRejectedValueOnce(makeApiError(429))
      .mockRejectedValueOnce(makeApiError(429))
      .mockResolvedValueOnce(makeSuccessResponse());

    const client = new VisionClient();
    const result = await client.convert('base64', 'Title', 'Section');

    expect(mockCreate).toHaveBeenCalledTimes(3);
    expect(result).toContain('<!-- confidence: high -->');
  });

  it('throws VisionError after exhausting all retries on persistent 429', async () => {
    mockCreate.mockRejectedValue(makeApiError(429));

    const client = new VisionClient();
    await expect(client.convert('base64', 'Title', 'Section')).rejects.toThrow(VisionError);
    // 1 initial + 3 retries = 4 total calls
    expect(mockCreate).toHaveBeenCalledTimes(4);
  });

  it('retries on HTTP 500 (server error)', async () => {
    mockCreate
      .mockRejectedValueOnce(makeApiError(500))
      .mockResolvedValueOnce(makeSuccessResponse());

    const client = new VisionClient();
    const result = await client.convert('base64', 'Title', 'Section');

    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(result).toBeTruthy();
  });

  it('does not retry on HTTP 400 (bad request)', async () => {
    mockCreate.mockRejectedValue(makeApiError(400));

    const client = new VisionClient();
    await expect(client.convert('base64', 'Title', 'Section')).rejects.toThrow(VisionError);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('does not retry on HTTP 401 (unauthorized)', async () => {
    mockCreate.mockRejectedValue(makeApiError(401));

    const client = new VisionClient();
    await expect(client.convert('base64', 'Title', 'Section')).rejects.toThrow(VisionError);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// VisionError shape
// ---------------------------------------------------------------------------

describe('VisionError', () => {
  it('carries the model name from the VisionClient that threw it', async () => {
    mockCreate.mockRejectedValue(makeApiError(429));

    const client = new VisionClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let caught: any = null;
    await client.convert('base64', 'Title', 'Section').catch((e: unknown) => {
      caught = e;
    });

    expect(caught).toBeInstanceOf(VisionError);
    expect(caught.model).toBe('claude-sonnet-4-6');
  });

  it('carries the HTTP status code from the API error', async () => {
    mockCreate.mockRejectedValue(makeApiError(429));

    const client = new VisionClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let caught: any = null;
    await client.convert('base64', 'Title', 'Section').catch((e: unknown) => {
      caught = e;
    });

    expect(caught.httpStatus).toBe(429);
  });

  it('reports retryable: true for 429', () => {
    const err = new VisionError('msg', 'claude-sonnet-4-6', 429);
    expect(err.retryable).toBe(true);
  });

  it('reports retryable: true for 503', () => {
    const err = new VisionError('msg', 'claude-sonnet-4-6', 503);
    expect(err.retryable).toBe(true);
  });

  it('reports retryable: false for 400', () => {
    const err = new VisionError('msg', 'claude-sonnet-4-6', 400);
    expect(err.retryable).toBe(false);
  });

  it('has the name property set to VisionError', () => {
    const err = new VisionError('msg', 'claude-sonnet-4-6', 429);
    expect(err.name).toBe('VisionError');
  });

  it('is an instance of Error', () => {
    const err = new VisionError('msg', 'claude-sonnet-4-6', 429);
    expect(err).toBeInstanceOf(Error);
  });
});
