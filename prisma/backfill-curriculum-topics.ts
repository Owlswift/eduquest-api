import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import { PrismaClient, ClassLevel } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const adapter = new PrismaPg(process.env.DATABASE_URL!);
const prisma = new PrismaClient({ adapter });

// Data lives in the sibling content-pipeline repo (eduquest/content-pipeline).
const REPO_ROOT = path.resolve(__dirname, "../../../content-pipeline");
const CURRICULUM_SCHEMA_DIR = path.join(REPO_ROOT, "curriculum-schema");

const SS1_SUBJECT_MAP: Record<string, string> = {
  "ss1-agricultural-science.json": "agricultural_science",
  "ss1-biology.json": "biology",
  "ss1-chemistry.json": "chemistry",
  "ss1-commerce.json": "commerce",
  "ss1-economics.json": "economics",
  "ss1-english-language.json": "english",
  "ss1-financial-accounting.json": "accounting",
  "ss1-government.json": "government",
  "ss1-history.json": "history",
  "ss1-marketing.json": "marketing",
  "ss1-mathematics.json": "math",
  "ss1-physics.json": "physics",
};

const JSS_SUBJECT_MAP: Record<string, string> = {
  "english-studies": "jss_english_studies",
  mathematics: "jss_mathematics",
  "physical-and-health-education": "jss_physical_and_health_education",
  "christian-religious-studies": "jss_christian_religious_studies",
  "islamic-studies": "jss_islamic_studies",
  "nigerian-history": "jss_nigerian_history",
  "social-and-citizenship-studies": "jss_social_and_citizenship_studies",
  "intermediate-science": "jss_intermediate_science",
  "digital-technologies": "jss_digital_technologies",
  "business-studies": "jss_business_studies",
};

interface FileTarget {
  file: string;
  subjectId: string;
  classLevel: ClassLevel;
}

function resolveTargets(): FileTarget[] {
  const files = fs.readdirSync(CURRICULUM_SCHEMA_DIR);
  const targets: FileTarget[] = [];

  for (const file of files) {
    if (SS1_SUBJECT_MAP[file]) {
      targets.push({ file, subjectId: SS1_SUBJECT_MAP[file], classLevel: "SS1" });
      continue;
    }
    const jssMatch = file.match(/^jss(\d)-(.+)\.json$/);
    if (jssMatch) {
      const [, level, slug] = jssMatch;
      const subjectId = JSS_SUBJECT_MAP[slug];
      if (subjectId) {
        targets.push({ file, subjectId, classLevel: `JSS${level}` as ClassLevel });
      } else {
        console.log(`[SKIP] ${file} - no subject mapping for slug "${slug}"`);
      }
    }
  }
  return targets;
}

async function main() {
  const targets = resolveTargets();
  let totalUpserted = 0;

  for (const { file, subjectId, classLevel } of targets) {
    const data = JSON.parse(
      fs.readFileSync(path.join(CURRICULUM_SCHEMA_DIR, file), "utf8"),
    );
    const topics: any[] = data.topics ?? [];

    for (const t of topics) {
      await prisma.curriculumTopic.upsert({
        where: {
          subjectId_classLevel_theme_topic: {
            subjectId,
            classLevel,
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
          sourcePage: t.page ?? null,
        },
        create: {
          subjectId,
          classLevel,
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
          sourcePage: t.page ?? null,
        },
      });
    }

    totalUpserted += topics.length;
    console.log(`[OK] ${file} -> ${subjectId}/${classLevel}: ${topics.length} topics upserted`);
  }

  console.log(`\nDone. ${totalUpserted} topic rows upserted across ${targets.length} files.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
