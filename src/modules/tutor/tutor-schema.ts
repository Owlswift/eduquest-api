import { z } from 'zod';

/**
 * Structured output contract for every tutor turn. The LLM never just
 * returns prose - it returns content blocks the client can render
 * differently (explanation vs analogy vs quiz), plus a signal the state
 * machine uses to decide whether to advance, retry, or simplify.
 */
const TutorBlockSchema = z.object({
  type: z.enum([
    'explanation',
    'analogy',
    'example',
    'question',
    'quiz',
    'encouragement',
    'diagram',
    'flashcard',
    'illustration',
  ]),
  content: z.string().min(1),
  // Only present when type is "quiz" - a single multiple-choice check.
  options: z.array(z.string()).optional(),
  correctOptionIndex: z.number().int().min(0).optional(),
  // Only present when type is "diagram" - the key labeled parts the client
  // should render around the description in `content`.
  diagramLabels: z.array(z.string()).optional(),
  // Only present when type is "diagram" - valid Mermaid syntax (flowchart or
  // graph) built only from diagramLabels/content, so the rendered diagram is
  // exactly what was taught, never an invented visual.
  mermaidCode: z.string().optional(),
  // Only present when type is "flashcard" - `content` is the front
  // (question/prompt), `back` is the answer to reveal.
  back: z.string().optional(),
});

export const TutorTurnSchema = z.object({
  blocks: z.array(TutorBlockSchema).min(1),
  // The engine's read on how the student is doing this turn, used to
  // decide the next LessonState transition.
  studentSignal: z.enum(['ADVANCE', 'RETRY', 'STRUGGLING']),
  // A short list of concept tags the student appears weak on right now
  // (empty if none detected this turn). Merged into StudentMastery.weakAreas.
  weakAreaTags: z.array(z.string()).default([]),
  // -10..+10 nudge applied to the student's mastery score for this topic.
  masteryDelta: z.number().int().min(-10).max(10).default(0),
});

export type TutorBlock = z.infer<typeof TutorBlockSchema>;
export type TutorTurn = z.infer<typeof TutorTurnSchema>;

/**
 * Plain JSON Schema mirror of the Zod schema above, for Ollama's
 * structured output ("format") parameter.
 */
export const TUTOR_TURN_JSON_SCHEMA = {
  type: 'object',
  properties: {
    blocks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: [
              'explanation',
              'analogy',
              'example',
              'question',
              'quiz',
              'encouragement',
              'diagram',
              'flashcard',
              'illustration',
            ],
          },
          content: { type: 'string' },
          options: { type: 'array', items: { type: 'string' } },
          correctOptionIndex: { type: 'integer' },
          diagramLabels: { type: 'array', items: { type: 'string' } },
          mermaidCode: { type: 'string' },
          back: { type: 'string' },
        },
        required: ['type', 'content'],
      },
    },
    studentSignal: {
      type: 'string',
      enum: ['ADVANCE', 'RETRY', 'STRUGGLING'],
    },
    weakAreaTags: { type: 'array', items: { type: 'string' } },
    masteryDelta: { type: 'integer' },
  },
  required: ['blocks', 'studentSignal', 'weakAreaTags', 'masteryDelta'],
} as const;
