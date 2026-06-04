/**
 * Vision LLM client wrapper for the Lemma pipeline.
 *
 * Wraps the chosen vision model SDK (claude-sonnet-4-6 via @anthropic-ai/sdk
 * by default) and handles retries, logging, and cost estimation.
 */

/**
 * Client for sending page images to the chosen vision model and
 * receiving structured Markdown transcription responses.
 */
export class VisionClient {
  /**
   * Sends a base64-encoded JPEG image and the system + user prompts to the
   * configured vision model and returns the raw model response string.
   *
   * Retries up to 3 times on retryable errors (HTTP 429 or 5xx).
   * Logs token counts and wall-clock latency to stderr on each call.
   *
   * @param imageBase64 - Base64-encoded JPEG image of the rendered page.
   * @param pageTitle - Page title injected into the user prompt template.
   * @param sectionName - Section name injected into the user prompt template.
   * @returns Raw model response string (full Markdown including confidence comment).
   * @throws VisionError when the API call fails after all retries.
   */
  async convert(
    imageBase64: string,
    pageTitle: string,
    sectionName: string,
  ): Promise<string> {
    void imageBase64;
    void pageTitle;
    void sectionName;
    throw new Error('VisionClient.convert is not yet implemented');
  }
}
