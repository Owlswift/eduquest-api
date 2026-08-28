import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CURRICULUM_PAGE_EXTRACTION_JSON_SCHEMA,
  CurriculumExtractionResultSchema,
  CurriculumTopic,
} from './curriculum-schema';

export interface PageExtractionOutcome {
  page: number;
  topics: CurriculumTopic[];
  error?: string;
}

const SYSTEM_PROMPT = `You extract structured curriculum data from a single page of a Nigerian NERDC senior secondary school curriculum PDF.

Each curriculum topic is laid out as a table with these header lines above it: "Theme", "Learning Outcome" (sometimes "Learning Outcomes"), and "Focal Competence" (sometimes "Focal Competency"). The table itself has columns: TOPIC, PERFORMANCE OBJECTIVES, CONTENT (KNOWLEDGE AND SKILLS), KEY COMPETENCIES AND VALUES, LEARNING ACTIVITIES, TEACHING AND LEARNING RESOURCES, EVALUATION GUIDE.

Rules:
- A page may contain zero, one, or two topic tables. Cover pages, forewords, prefaces, tables of contents, and introduction pages contain no topic tables - return an empty "topics" array for those.
- "content.knowledge" items are either a plain fact/string, or a labelled group with sub-items (e.g. a bullet list under a sub-heading). Preserve that structure instead of flattening it.
- "content.skills" is frequently absent - only include items that are explicitly under a "Skill" or "Skills" heading in the Content column.
- "key_competencies_and_values" entries are bolded competency names (e.g. "Collaboration", "ICT and Digital competence") each followed by a description clause starting with "as students...". Split each into {name, description}.
- Number lists in the source (1., 2., 3.) are not meaningful beyond ordering - strip the numbering from extracted strings.
- Do not invent content that is not on the page. If a page has no topic table, return {"topics": []}.

Respond with JSON only, matching the provided schema.`;

@Injectable()
export class LlmExtractionService {
  private readonly logger = new Logger(LlmExtractionService.name);
  private readonly baseUrl: string;
  private readonly model: string;

  constructor(private config: ConfigService) {
    this.baseUrl =
      this.config.get<string>('OLLAMA_BASE_URL') ?? 'http://localhost:11434';
    this.model = this.config.get<string>('OLLAMA_MODEL') ?? 'gpt-oss:20b';
  }

  async extractTopicsFromPage(params: {
    page: number;
    pageText: string;
    subjectName: string;
    classLevel: string;
  }): Promise<PageExtractionOutcome> {
    const { page, pageText, subjectName, classLevel } = params;

    // Pages with barely any text (blank separators, cover art pages) can't
    // contain a topic table - skip the model call entirely.
    if (pageText.trim().length < 20) {
      return { page, topics: [] };
    }

    const userPrompt = `Subject: ${subjectName}\nClass level: ${classLevel}\nPage ${page} raw text:\n\n${pageText}`;

    try {
      const response = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userPrompt },
          ],
          format: CURRICULUM_PAGE_EXTRACTION_JSON_SCHEMA,
          stream: false,
          options: { temperature: 0 },
        }),
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Ollama request failed (${response.status}): ${body}`);
      }

      const data = (await response.json()) as {
        message?: { content?: string };
      };
      const raw = data.message?.content;
      if (!raw) {
        throw new Error('Ollama response had no message content');
      }

      const parsed = CurriculumExtractionResultSchema.safeParse(
        JSON.parse(raw),
      );
      if (!parsed.success) {
        throw new Error(
          `Model output failed schema validation: ${parsed.error.message}`,
        );
      }

      const topics = parsed.data.topics.map((t) => ({ ...t, page }));
      return { page, topics };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Extraction failed for page ${page}: ${message}`);
      return { page, topics: [], error: message };
    }
  }
}
