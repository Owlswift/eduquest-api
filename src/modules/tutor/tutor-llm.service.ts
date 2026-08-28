import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LessonState } from '@prisma/client';
import {
  TUTOR_TURN_JSON_SCHEMA,
  TutorTurn,
  TutorTurnSchema,
} from './tutor-schema';

export interface TutorTopicContext {
  subjectName: string;
  classLevel: string;
  theme: string;
  topic: string;
  learningOutcome: string;
  focalCompetence: string;
  performanceObjectives: string[];
  knowledge: unknown[];
  evaluationGuide: string[];
}

export interface TutorHistoryEntry {
  role: 'TUTOR' | 'STUDENT';
  content: string;
}

export interface GenerateTurnParams {
  state: LessonState;
  topic: TutorTopicContext;
  masteryScore: number;
  weakAreas: string[];
  history: TutorHistoryEntry[];
  studentMessage?: string;
}

const SYSTEM_PROMPT = `You are the EduQuest AI Tutor, teaching a Nigerian secondary school student one curriculum topic at a time.

Rules:
- Stay strictly within the provided curriculum content (learning outcome, focal competence, performance objectives, knowledge points). Do not introduce facts outside the syllabus for this topic.
- Never dump everything at once. Each turn should contain one small idea, phrased simply, often with a relatable Nigerian-context analogy.
- Ask exactly one question per turn to check understanding, except during MINI_QUIZ (a structured quiz block) or COMPLETED (no question needed).
- Read the student's last message to judge whether they understood. Set studentSignal to ADVANCE if they clearly grasped the idea, RETRY if they made a small mistake worth correcting once more, or STRUGGLING if they are lost and need simplification/a different analogy.
- Your next question or explanation must directly react to what the student just said - correct/build on a specific word or idea from their answer, or acknowledge "I don't know"/a guess before moving on. Never ignore their answer and jump to an unrelated fact from the curriculum content just because it's next on the list - that reads as not listening.
- Whenever you're responding to something the student answered (i.e. this isn't the very first turn), open with a short, natural, spoken-sounding reaction to their specific answer before anything else - genuine praise for a correct or thoughtful answer ("Nice one!", "Exactly right!"), a warm but honest correction for a wrong one ("Close, but not quite - ..."), or gentle encouragement for "I don't know" ("No worries, let's figure it out together"). Vary the phrasing turn to turn - never reuse the same stock phrase twice in a row. This reaction is part of the same block's text, not a separate block.
- If studentSignal is STRUGGLING, simplify further and use a different, more concrete analogy - do not repeat the same explanation.
- Use a "diagram" block only when the concept is genuinely structural/spatial (e.g. a labelled process, parts of a structure, a cycle). For a diagram block, "content" MUST be a short plain-English caption (e.g. "The main parts of an animal cell") - the Mermaid syntax itself goes ONLY in the separate "mermaidCode" field, never inside "content". Set diagramLabels to the key parts the student should be able to point to, and set mermaidCode to valid Mermaid syntax (a "flowchart TD" or "graph LR") whose nodes are exactly the diagramLabels, connected only the way the curriculum content actually describes them (e.g. steps in a process go in teaching order; parts of a structure branch from a central node). Never invent a relationship the curriculum content doesn't state. Do not add a diagram for purely abstract or definitional content, and never more than one diagram block per turn. Example of a correct diagram block: {"type": "diagram", "content": "The main parts of an animal cell", "diagramLabels": ["Cell Membrane", "Cytoplasm", "Nucleus"], "mermaidCode": "graph TD\\n  CM[Cell Membrane] --> CP[Cytoplasm]\\n  CP --> N[Nucleus]"}
- Use an "illustration" block only for a purely decorative, non-label-critical moment where a picture would make the scene more vivid (e.g. "a farmer working under sunlight") - "content" becomes a plain-English image generation prompt. Never use illustration for anything where an incorrect or approximate visual could mislead the student about a fact (that's what "diagram" is for). At most one illustration block per turn, and only when it clearly adds value beyond the text.
- Use "flashcard" blocks only when explicitly asked for in this turn's instruction below - each flashcard's "content" field is the front (a short prompt/question) and its "back" field is the answer, both drawn only from this topic's curriculum content.
- weakAreaTags should list specific sub-concepts (e.g. "chemical equation balancing") the student is currently weak on, based on this turn only. Leave empty if nothing stands out.
- masteryDelta is a small integer nudge (-10 to +10) reflecting how this single turn changed your read of the student's mastery of the topic - not a cumulative score.
- Respond with JSON only, matching the provided schema.`;

const STATE_INSTRUCTIONS: Record<LessonState, string> = {
  INTRODUCTION:
    'This is the very first turn of the session. Warmly introduce the topic in one or two sentences and set expectations, then immediately ask a simple question to see what the student already knows (do not teach yet, and do not use the phrase "diagnostic question" or similar jargon - just ask naturally, like a teacher would). One block of type "question" is enough.',
  ASSESS_PRIOR_KNOWLEDGE:
    'Continue gently probing what the student already knows about this topic with one focused question per turn. After 2-3 exchanges, or as soon as you have a clear read, set studentSignal to ADVANCE so the lesson can move into teaching.',
  EXPLAIN_CONCEPT:
    'Teach the next small concept from the curriculum content using an "explanation" block and an "analogy" block, then a "question" block checking understanding. Cover one concept per turn, not the whole topic. If (and only if) this concept describes a structure, process, or cycle with distinct parts, add one "diagram" block instead of relying purely on text. Separately, if the analogy would land better with a vivid mental picture (not label-critical), you may add one "illustration" block instead.',
  EXAMPLE:
    'Give one worked example directly related to the concept just explained, using an "example" block, then ask a "question" block that has the student apply the same reasoning to a similar case.',
  CHECK_UNDERSTANDING:
    'Ask a slightly harder question than before, requiring the student to combine what they have learned so far in this topic. This determines whether they are ready for the quiz.',
  MINI_QUIZ:
    'Give exactly one multiple-choice question as a "quiz" block (3-4 options, correctOptionIndex set) covering the topic\'s core learning outcome. If the student already answered a quiz question last turn, evaluate their answer in an "encouragement" or "explanation" block and, if correct, set studentSignal to ADVANCE.',
  COMPLETED:
    'The lesson is finished. Give a short, warm "encouragement" block summarising what the student achieved this session, followed by 3-5 "flashcard" blocks (front in `content`, answer in `back`) covering the topic\'s key facts for later spaced revision. No question is needed.',
};

@Injectable()
export class TutorLlmService {
  private readonly logger = new Logger(TutorLlmService.name);
  private readonly baseUrl: string;
  private readonly model: string;

  constructor(private config: ConfigService) {
    this.baseUrl =
      this.config.get<string>('OLLAMA_BASE_URL') ?? 'http://localhost:11434';
    this.model = this.config.get<string>('OLLAMA_MODEL') ?? 'gpt-oss:20b';
  }

  async generateTurn(params: GenerateTurnParams): Promise<TutorTurn> {
    const { state, topic, masteryScore, weakAreas, history, studentMessage } =
      params;

    const contextBlock = [
      `Subject: ${topic.subjectName}`,
      `Class level: ${topic.classLevel}`,
      `Theme: ${topic.theme}`,
      `Topic: ${topic.topic}`,
      `Learning outcome: ${topic.learningOutcome}`,
      `Focal competence: ${topic.focalCompetence}`,
      `Performance objectives: ${topic.performanceObjectives.join('; ')}`,
      `Knowledge points: ${JSON.stringify(topic.knowledge)}`,
      `Evaluation guide (what mastery looks like): ${topic.evaluationGuide.join('; ')}`,
      '',
      `Student's current mastery score for this topic: ${masteryScore}/100`,
      `Known weak areas so far: ${weakAreas.length ? weakAreas.join(', ') : 'none yet'}`,
      '',
      `Current lesson stage: ${state}`,
      `Your job this turn: ${STATE_INSTRUCTIONS[state]}`,
    ].join('\n');

    const historyText = history
      .slice(-6)
      .map((h) => `${h.role === 'TUTOR' ? 'Tutor' : 'Student'}: ${h.content}`)
      .join('\n');

    const userPrompt = [
      contextBlock,
      '',
      historyText
        ? `Recent conversation:\n${historyText}`
        : 'This is the first message of the session.',
      studentMessage ? `\nStudent just said: "${studentMessage}"` : '',
    ]
      .filter(Boolean)
      .join('\n');

    // Constrained JSON decoding on gpt-oss:20b occasionally returns a
    // structurally valid but empty/incomplete turn (e.g. blocks: []).
    // One retry clears the large majority of these before we fall back.
    for (let attempt = 0; attempt < 2; attempt++) {
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
            format: TUTOR_TURN_JSON_SCHEMA,
            stream: false,
            options: { temperature: 0.4 },
          }),
        });

        if (!response.ok) {
          const body = await response.text();
          throw new Error(
            `Ollama request failed (${response.status}): ${body}`,
          );
        }

        const data = (await response.json()) as {
          message?: { content?: string };
        };
        const raw = data.message?.content;
        if (!raw) {
          throw new Error('Ollama response had no message content');
        }

        const parsed = TutorTurnSchema.safeParse(JSON.parse(raw));
        if (!parsed.success) {
          throw new Error(
            `Model output failed schema validation: ${parsed.error.message}`,
          );
        }

        return parsed.data;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (attempt === 0) {
          this.logger.warn(
            `Tutor turn generation attempt failed, retrying once: ${message}`,
          );
          continue;
        }
        this.logger.error(`Tutor turn generation failed: ${message}`);
      }
    }

    // Degrade gracefully rather than breaking the student's session.
    return {
      blocks: [
        {
          type: 'encouragement',
          content:
            "Sorry, I'm having trouble thinking right now. Let's try that again in a moment.",
        },
      ],
      studentSignal: 'RETRY',
      weakAreaTags: [],
      masteryDelta: 0,
    };
  }
}
