/**
 * Vision LLM system prompt and user prompt template for the Lemma pipeline.
 *
 * The system prompt encodes all constraints the vision model must follow:
 * callout syntax, LaTeX conventions, diagram JSON format, confidence annotation,
 * and honesty requirements. It is sent unchanged with every API call.
 *
 * The user prompt template is interpolated per page, injecting the page title
 * and section name so the model has context for the transcription task.
 */

/**
 * System prompt sent with every vision API call.
 *
 * Encodes the full callout convention, math formatting rules, diagram JSON
 * schema, confidence annotation syntax, and strict honesty constraints.
 * The prompt must not be modified without re-validating against representative
 * handwritten pages to confirm the model still produces well-formed output.
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

/**
 * User-turn prompt template for the vision API call.
 *
 * The placeholders `{{pageTitle}}` and `{{sectionName}}` are replaced at
 * call time with the actual page title and section name before being sent
 * to the model.
 *
 * @example
 * const userText = USER_PROMPT_TEMPLATE
 *   .replace('{{pageTitle}}', 'Eulerian Graphs')
 *   .replace('{{sectionName}}', 'Graph Theory');
 */
export const USER_PROMPT_TEMPLATE =
  `Please transcribe the following OneNote page titled "{{pageTitle}}" ` +
  `from the section "{{sectionName}}".\n` +
  `Follow the callout convention and formatting rules exactly as specified ` +
  `in the system prompt. Transcribe all handwritten content faithfully, ` +
  `preserving mathematical notation, proof structure, and diagram descriptions.`;
