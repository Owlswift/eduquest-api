import "dotenv/config";
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { PrismaClient, ExamType, ClassLevel } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const adapter = new PrismaPg(process.env.DATABASE_URL!);
const prisma = new PrismaClient({ adapter });

// apps/api/prisma -> apps
const REPO_ROOT = path.resolve(__dirname, "../..");
const MCQ_DIR = process.env.MCQ_IMPORT_DIR || path.join(REPO_ROOT, "mcq_import");
const THEORY_DIR = process.env.THEORY_IMPORT_DIR || path.join(REPO_ROOT, "theory_import");

const CHUNK_SIZE = 1000;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

interface McqOption {
  text: string;
  isCorrect: boolean;
}

interface McqSource {
  subjectId: string;
  classLevel: ClassLevel;
  topic: string | null;
  questionText: string;
  explanation: string | null;
  examType: ExamType | null;
  examYear: number | null;
  options: McqOption[];
}

interface TheorySource {
  subjectId: string;
  classLevel: ClassLevel;
  topic: string | null;
  questionText: string;
  examType: ExamType | null;
  examYear: number | null;
  paper: string | null;
  observation: string | null;
  generalComments: string | null;
  weaknessesRemedies: string | null;
  strengths: string | null;
  imageUrls: string[];
}

async function importMcq() {
  const subjectDirs = fs.readdirSync(MCQ_DIR).filter((d) =>
    fs.statSync(path.join(MCQ_DIR, d)).isDirectory(),
  );

  let totalQuestions = 0;
  let totalOptions = 0;

  for (const subjectId of subjectDirs) {
    const file = path.join(MCQ_DIR, subjectId, "questions.json");
    const records: McqSource[] = JSON.parse(fs.readFileSync(file, "utf8"));

    const questionRows: any[] = [];
    const optionRows: any[] = [];

    for (const rec of records) {
      const questionId = randomUUID();
      const optionIds = rec.options.map(() => randomUUID());
      const correctIndex = rec.options.findIndex((o) => o.isCorrect);

      questionRows.push({
        id: questionId,
        subjectId: rec.subjectId,
        classLevel: rec.classLevel,
        topic: rec.topic,
        questionText: rec.questionText,
        explanation: rec.explanation,
        difficulty: 1,
        correctAnswerId: optionIds[correctIndex],
        examType: rec.examType,
        examYear: rec.examYear,
      });

      rec.options.forEach((o, i) => {
        optionRows.push({
          id: optionIds[i],
          questionId,
          text: o.text,
        });
      });
    }

    for (const batch of chunk(questionRows, CHUNK_SIZE)) {
      await prisma.question.createMany({ data: batch });
    }
    for (const batch of chunk(optionRows, CHUNK_SIZE)) {
      await prisma.answerOption.createMany({ data: batch });
    }

    totalQuestions += questionRows.length;
    totalOptions += optionRows.length;
    console.log(
      `[MCQ] ${subjectId}: ${questionRows.length} questions, ${optionRows.length} options`,
    );
  }

  console.log(`[MCQ DONE] ${totalQuestions} questions, ${totalOptions} options total`);
}

async function importTheory() {
  const subjectDirs = fs.readdirSync(THEORY_DIR).filter((d) =>
    fs.statSync(path.join(THEORY_DIR, d)).isDirectory(),
  );

  let total = 0;

  for (const subjectId of subjectDirs) {
    const file = path.join(THEORY_DIR, subjectId, "questions.json");
    const records: TheorySource[] = JSON.parse(fs.readFileSync(file, "utf8"));

    const rows = records.map((rec) => ({
      id: randomUUID(),
      subjectId: rec.subjectId,
      classLevel: rec.classLevel,
      topic: rec.topic,
      questionText: rec.questionText,
      examType: rec.examType,
      examYear: rec.examYear,
      paper: rec.paper,
      observation: rec.observation,
      generalComments: rec.generalComments,
      weaknessesRemedies: rec.weaknessesRemedies,
      strengths: rec.strengths,
      imageUrls: rec.imageUrls,
    }));

    for (const batch of chunk(rows, CHUNK_SIZE)) {
      await prisma.theoryQuestion.createMany({ data: batch });
    }

    total += rows.length;
    console.log(`[THEORY] ${subjectId}: ${rows.length} questions`);
  }

  console.log(`[THEORY DONE] ${total} questions total`);
}

async function main() {
  console.log("Importing MCQ questions (myschool.ng)...");
  await importMcq();
  console.log("\nImporting theory questions (WAEC)...");
  await importTheory();
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
