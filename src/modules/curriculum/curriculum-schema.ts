import { z } from 'zod';

/**
 * Mirrors the schema validated against real NERDC SSS1 curriculum PDFs
 * (Agricultural Science, English Language) before this importer was built.
 * `content.knowledge` items are either a plain string or a labelled group
 * of sub-items (e.g. "Origin and development of agriculture" -> ["Stone
 * Age", "Modern Agriculture"]) - both shapes occur throughout real curricula.
 */
const KnowledgeItem = z.union([
  z.string(),
  z.object({
    label: z.string(),
    items: z.array(z.string()),
  }),
]);

const KeyCompetency = z.object({
  name: z.string(),
  description: z.string(),
});

export const CurriculumTopicSchema = z.object({
  theme: z.string().min(1),
  learning_outcome: z.string().min(1),
  focal_competence: z.string().min(1),
  topic: z.string().min(1),
  performance_objectives: z.array(z.string()).min(1),
  content: z.object({
    knowledge: z.array(KnowledgeItem).default([]),
    skills: z.array(z.string()).default([]),
  }),
  key_competencies_and_values: z.array(KeyCompetency).default([]),
  learning_activities: z.array(z.string()).default([]),
  teaching_and_learning_resources: z.array(z.string()).default([]),
  evaluation_guide: z.array(z.string()).default([]),
  page: z.number().int().positive().optional(),
});

export type CurriculumTopic = z.infer<typeof CurriculumTopicSchema>;

export const CurriculumExtractionResultSchema = z.object({
  topics: z.array(CurriculumTopicSchema),
});

export type CurriculumExtractionResult = z.infer<
  typeof CurriculumExtractionResultSchema
>;

/**
 * Plain JSON Schema mirroring the Zod schema above, for Ollama's structured
 * output ("format") parameter - Ollama does not accept Zod schemas directly.
 * Keep the two in sync when the shape changes.
 */
export const CURRICULUM_PAGE_EXTRACTION_JSON_SCHEMA = {
  type: 'object',
  properties: {
    topics: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          theme: { type: 'string' },
          learning_outcome: { type: 'string' },
          focal_competence: { type: 'string' },
          topic: { type: 'string' },
          performance_objectives: { type: 'array', items: { type: 'string' } },
          content: {
            type: 'object',
            properties: {
              knowledge: {
                type: 'array',
                items: {
                  anyOf: [
                    { type: 'string' },
                    {
                      type: 'object',
                      properties: {
                        label: { type: 'string' },
                        items: { type: 'array', items: { type: 'string' } },
                      },
                      required: ['label', 'items'],
                    },
                  ],
                },
              },
              skills: { type: 'array', items: { type: 'string' } },
            },
            required: ['knowledge', 'skills'],
          },
          key_competencies_and_values: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                description: { type: 'string' },
              },
              required: ['name', 'description'],
            },
          },
          learning_activities: { type: 'array', items: { type: 'string' } },
          teaching_and_learning_resources: {
            type: 'array',
            items: { type: 'string' },
          },
          evaluation_guide: { type: 'array', items: { type: 'string' } },
        },
        required: [
          'theme',
          'learning_outcome',
          'focal_competence',
          'topic',
          'performance_objectives',
          'content',
          'key_competencies_and_values',
          'learning_activities',
          'teaching_and_learning_resources',
          'evaluation_guide',
        ],
      },
    },
  },
  required: ['topics'],
} as const;
