import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ClassLevel, CurriculumImportStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { PdfExtractionService } from './pdf-extraction.service';
import { LlmExtractionService } from './llm-extraction.service';
import {
  CurriculumExtractionResultSchema,
  CurriculumTopic,
} from './curriculum-schema';

@Injectable()
export class CurriculumService {
  constructor(
    private prisma: PrismaService,
    private pdfExtraction: PdfExtractionService,
    private llmExtraction: LlmExtractionService,
  ) {}

  async createImport(params: {
    subjectId: string;
    classLevel: ClassLevel;
    fileName: string;
    buffer: Buffer;
  }) {
    const { subjectId, classLevel, fileName, buffer } = params;

    const subject = await this.prisma.subject.findUnique({
      where: { id: subjectId },
    });
    if (!subject) {
      throw new BadRequestException(`Unknown subjectId "${subjectId}"`);
    }

    const pages = await this.pdfExtraction.extractPages(buffer);

    return this.prisma.curriculumImport.create({
      data: {
        subjectId,
        classLevel,
        fileName,
        pageCount: pages.length,
        rawPages: pages as unknown as Prisma.InputJsonValue,
        status: CurriculumImportStatus.UPLOADED,
      },
    });
  }

  async getImport(id: string) {
    const record = await this.prisma.curriculumImport.findUnique({
      where: { id },
    });
    if (!record)
      throw new NotFoundException(`Curriculum import "${id}" not found`);
    return record;
  }

  async listImports(filters: {
    subjectId?: string;
    status?: CurriculumImportStatus;
  }) {
    return this.prisma.curriculumImport.findMany({
      where: { subjectId: filters.subjectId, status: filters.status },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Runs the LLM extraction pass over every page of the import, sequentially
   * (a local single-GPU Ollama instance can't usefully parallelize this).
   * Per-page failures don't abort the run - they're recorded so the admin
   * review step can see exactly which pages need a manual look or a retry.
   */
  async runExtraction(id: string) {
    const record = await this.getImport(id);
    const pages =
      (record.rawPages as unknown as { page: number; text: string }[]) ?? [];
    const subject = await this.prisma.subject.findUniqueOrThrow({
      where: { id: record.subjectId },
    });

    await this.prisma.curriculumImport.update({
      where: { id },
      data: { status: CurriculumImportStatus.EXTRACTING },
    });

    const topics: CurriculumTopic[] = [];
    const validationErrors: { page: number; error: string }[] = [];

    for (const page of pages) {
      const outcome = await this.llmExtraction.extractTopicsFromPage({
        page: page.page,
        pageText: page.text,
        subjectName: subject.name,
        classLevel: record.classLevel,
      });

      topics.push(...outcome.topics);
      if (outcome.error) {
        validationErrors.push({ page: page.page, error: outcome.error });
      }
    }

    const status =
      topics.length > 0
        ? CurriculumImportStatus.EXTRACTED
        : CurriculumImportStatus.EXTRACTION_FAILED;

    return this.prisma.curriculumImport.update({
      where: { id },
      data: {
        status,
        extractedJson: { topics },
        validationErrors: validationErrors,
        errorMessage:
          status === CurriculumImportStatus.EXTRACTION_FAILED
            ? 'No topics could be extracted from any page'
            : null,
      },
    });
  }

  /**
   * Lets an admin overwrite the extracted JSON after reviewing it (fixing a
   * mis-parsed table, merging a topic the model split in two, etc.) before
   * approving it into the topics table.
   */
  async updateExtractedJson(id: string, topics: unknown) {
    await this.getImport(id);

    const parsed = CurriculumExtractionResultSchema.safeParse({ topics });
    if (!parsed.success) {
      throw new BadRequestException({
        message: 'Submitted curriculum JSON failed schema validation',
        issues: parsed.error.issues,
      });
    }

    return this.prisma.curriculumImport.update({
      where: { id },
      data: {
        extractedJson: parsed.data,
        validationErrors: [],
        status: CurriculumImportStatus.REVIEWED,
      },
    });
  }

  /**
   * Persists the reviewed extraction into the queryable CurriculumTopic
   * table. Upserts on (subjectId, classLevel, theme, topic) so re-approving
   * an updated import overwrites the same rows instead of duplicating them.
   */
  async approveImport(id: string) {
    const record = await this.getImport(id);

    if (!record.extractedJson) {
      throw new ConflictException(
        'Import has no extracted JSON to approve - run extraction first',
      );
    }

    const parsed = CurriculumExtractionResultSchema.safeParse(
      record.extractedJson,
    );
    if (!parsed.success) {
      throw new ConflictException({
        message:
          'Stored extraction no longer passes schema validation - fix it via PATCH before approving',
        issues: parsed.error.issues,
      });
    }
    if (parsed.data.topics.length === 0) {
      throw new ConflictException('Cannot approve an import with zero topics');
    }

    await this.prisma.$transaction(
      parsed.data.topics.map((t) =>
        this.prisma.curriculumTopic.upsert({
          where: {
            subjectId_classLevel_theme_topic: {
              subjectId: record.subjectId,
              classLevel: record.classLevel,
              theme: t.theme,
              topic: t.topic,
            },
          },
          update: {
            learningOutcome: t.learning_outcome,
            focalCompetence: t.focal_competence,
            performanceObjectives: t.performance_objectives,
            content: t.content,
            keyCompetenciesAndValues: t.key_competencies_and_values,
            learningActivities: t.learning_activities,
            teachingLearningResources: t.teaching_and_learning_resources,
            evaluationGuide: t.evaluation_guide,
            sourcePage: t.page,
            importId: record.id,
          },
          create: {
            subjectId: record.subjectId,
            classLevel: record.classLevel,
            importId: record.id,
            theme: t.theme,
            learningOutcome: t.learning_outcome,
            focalCompetence: t.focal_competence,
            topic: t.topic,
            performanceObjectives: t.performance_objectives,
            content: t.content,
            keyCompetenciesAndValues: t.key_competencies_and_values,
            learningActivities: t.learning_activities,
            teachingLearningResources: t.teaching_and_learning_resources,
            evaluationGuide: t.evaluation_guide,
            sourcePage: t.page,
          },
        }),
      ),
    );

    return this.prisma.curriculumImport.update({
      where: { id },
      data: { status: CurriculumImportStatus.SAVED },
    });
  }

  async listTopics(filters: { subjectId?: string; classLevel?: ClassLevel }) {
    return this.prisma.curriculumTopic.findMany({
      where: { subjectId: filters.subjectId, classLevel: filters.classLevel },
      orderBy: [{ theme: 'asc' }, { sourcePage: 'asc' }],
    });
  }
}
