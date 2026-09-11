import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { ActivityService } from '../activity/activity.service';
import { ClassLevel } from '@prisma/client';

@Injectable()
export class QuizService {
  constructor(
    private prisma: PrismaService,
    private activity: ActivityService,
  ) {}

  // ─── GET /quiz/questions ────────────────────────────────────────────────────

  async getRandomQuestions(
    subjectId: string,
    count: number = 10,
    classLevel: ClassLevel = ClassLevel.SS1,
  ) {
    // Verify subject exists
    const subject = await this.prisma.subject.findUnique({
      where: { id: subjectId },
    });
    if (!subject) throw new NotFoundException(`Subject ${subjectId} not found`);

    // Fetch all matching questions then randomise in JS
    // (avoids ORDER BY RANDOM() which is slow on large tables)
    const all = await this.prisma.question.findMany({
      where: { subjectId, classLevel },
      include: { options: true },
    });

    const shuffled = all.sort(() => Math.random() - 0.5).slice(0, count);

    // correctAnswerId is deliberately withheld - sending it would let a
    // client read the answer straight out of the network response.
    // Grading happens server-side in submitQuizResults instead.
    return shuffled.map((q) => ({
      id: q.id,
      subjectId: q.subjectId,
      classLevel: q.classLevel,
      questionText: q.questionText,
      explanation: q.explanation,
      difficulty: q.difficulty,
      options: q.options.map((o) => ({ id: o.id, text: o.text })),
    }));
  }

  // ─── POST /quiz/questions/:id/check ──────────────────────────────────────────

  /** Reveals whether one already-answered question was right, for a
   *  student who's just picked an option and wants immediate feedback
   *  before moving on. Stateless - doesn't affect scoring, so it's safe
   *  to call per-question without opening the same "read the correct
   *  answer off the network before answering" hole that including
   *  correctAnswerId in the question list would. */
  async checkAnswer(questionId: string, selectedOptionId: string) {
    const question = await this.prisma.question.findUnique({
      where: { id: questionId },
      select: { correctAnswerId: true, explanation: true },
    });
    if (!question) throw new NotFoundException('Question not found');

    return {
      correct: question.correctAnswerId === selectedOptionId,
      correctOptionId: question.correctAnswerId,
      explanation: question.explanation,
    };
  }

  // ─── POST /quiz/submit ──────────────────────────────────────────────────────

  async submitQuizResults(
    userId: string,
    dto: {
      subjectId: string;
      answers: { questionId: string; selectedOptionId: string }[];
      timeTaken: number;
    },
  ) {
    const COINS_PER_CORRECT = 10;
    const XP_PER_CORRECT = 10;

    // Grade server-side: look up the real correctAnswerId for every
    // question submitted, rather than trusting a client-reported score.
    const questions = await this.prisma.question.findMany({
      where: { id: { in: dto.answers.map((a) => a.questionId) } },
      select: { id: true, correctAnswerId: true },
    });
    const correctById = new Map(questions.map((q) => [q.id, q.correctAnswerId]));

    const totalQuestions = dto.answers.length;
    const correctAnswers = dto.answers.filter(
      (a) => correctById.get(a.questionId) === a.selectedOptionId,
    ).length;

    const earnedCoins = correctAnswers * COINS_PER_CORRECT;
    const earnedXp = correctAnswers * XP_PER_CORRECT;

    // Update user stats atomically
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: {
        coins: { increment: earnedCoins },
        xp: { increment: earnedXp },
        questionsAnswered: { increment: totalQuestions },
        // Recalculate accuracy as rolling average
        accuracy: {
          set: await this._newAccuracy(userId, correctAnswers, totalQuestions),
        },
      },
      select: { id: true, coins: true, xp: true, questionsAnswered: true },
    });

    // Count these toward today's study activity / streak, and today's XP
    // toward the weekly/monthly leaderboard windows.
    await this.activity.recordQuestions(userId, totalQuestions);
    await this.activity.recordXp(userId, earnedXp);

    // Simple rank calculation — count users with more XP
    const [nationalRank, stateRank] = await Promise.all([
      this.prisma.user.count({ where: { xp: { gt: user.xp } } }).then((n) => n + 1),
      // State rank approximation (replace with real state field query later)
      this.prisma.user.count({ where: { xp: { gt: user.xp } } }).then((n) =>
        Math.max(1, Math.floor((n + 1) * 0.08)),
      ),
    ]);

    return {
      earnedCoins,
      earnedXp,
      questionsAnsweredInChallenge: totalQuestions,
      correctAnswers,
      nationalRank,
      stateRank,
      totalCoins: user.coins,
      totalXp: user.xp,
    };
  }

  // ─── Seed questions ─────────────────────────────────────────────────────────

  async seedQuestions() {
    const data = _seedData();
    let created = 0;

    // Ensure required subjects exist before seeding questions
    const requiredSubjectIds = [...new Set(data.map((q) => q.subjectId))];
    for (const subjectId of requiredSubjectIds) {
      await this.prisma.subject.upsert({
        where: { id: subjectId },
        update: {},
        create: { id: subjectId, name: subjectId, icon: 'school_rounded', color: '#FF000000' },
      });
    }

    for (const q of data) {
      const exists = await this.prisma.question.findUnique({ where: { id: q.id } });
      if (exists) continue;

      await this.prisma.question.create({
        data: {
          id: q.id,
          subjectId: q.subjectId,
          classLevel: q.classLevel as ClassLevel,
          questionText: q.questionText,
          explanation: q.explanation,
          difficulty: q.difficulty,
          correctAnswerId: q.correctAnswerId,
          options: {
            create: q.options.map((o) => ({ id: o.id, text: o.text })),
          },
        },
      });
      created++;
    }

    return { message: 'Questions seeded', created };
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private async _newAccuracy(
    userId: string,
    newCorrect: number,
    newTotal: number,
  ): Promise<number> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { accuracy: true, questionsAnswered: true },
    });
    if (!user) return newTotal > 0 ? newCorrect / newTotal : 0;

    const prevTotal = user.questionsAnswered;
    const prevCorrect = Math.round(user.accuracy * prevTotal);
    const total = prevTotal + newTotal;
    return total > 0 ? (prevCorrect + newCorrect) / total : 0;
  }
}

// ─── Seed data ────────────────────────────────────────────────────────────────

function _seedData() {
  return [
    // ── Mathematics ──────────────────────────────────────────────────────────
    {
      id: 'math_ss1_q1', subjectId: 'math', classLevel: 'SS1', difficulty: 1,
      questionText: 'What is the value of x in the equation: 2x + 5 = 13?',
      correctAnswerId: 'math_ss1_q1_b',
      explanation: '2x = 13 - 5 = 8, so x = 4',
      options: [
        { id: 'math_ss1_q1_a', text: '3' },
        { id: 'math_ss1_q1_b', text: '4' },
        { id: 'math_ss1_q1_c', text: '5' },
        { id: 'math_ss1_q1_d', text: '6' },
      ],
    },
    {
      id: 'math_ss1_q2', subjectId: 'math', classLevel: 'SS1', difficulty: 1,
      questionText: 'Which of the following is a prime number?',
      correctAnswerId: 'math_ss1_q2_b',
      explanation: '17 is only divisible by 1 and itself',
      options: [
        { id: 'math_ss1_q2_a', text: '15' },
        { id: 'math_ss1_q2_b', text: '17' },
        { id: 'math_ss1_q2_c', text: '21' },
        { id: 'math_ss1_q2_d', text: '25' },
      ],
    },
    {
      id: 'math_ss1_q3', subjectId: 'math', classLevel: 'SS1', difficulty: 1,
      questionText: 'What is √144?',
      correctAnswerId: 'math_ss1_q3_c',
      explanation: '12 × 12 = 144',
      options: [
        { id: 'math_ss1_q3_a', text: '10' },
        { id: 'math_ss1_q3_b', text: '11' },
        { id: 'math_ss1_q3_c', text: '12' },
        { id: 'math_ss1_q3_d', text: '13' },
      ],
    },
    {
      id: 'math_ss1_q4', subjectId: 'math', classLevel: 'SS1', difficulty: 2,
      questionText: 'Solve: 3(x − 2) = 15',
      correctAnswerId: 'math_ss1_q4_c',
      explanation: 'x − 2 = 5, so x = 7',
      options: [
        { id: 'math_ss1_q4_a', text: '5' },
        { id: 'math_ss1_q4_b', text: '6' },
        { id: 'math_ss1_q4_c', text: '7' },
        { id: 'math_ss1_q4_d', text: '8' },
      ],
    },
    {
      id: 'math_ss1_q5', subjectId: 'math', classLevel: 'SS1', difficulty: 1,
      questionText: 'What is 15% of 200?',
      correctAnswerId: 'math_ss1_q5_b',
      explanation: '0.15 × 200 = 30',
      options: [
        { id: 'math_ss1_q5_a', text: '25' },
        { id: 'math_ss1_q5_b', text: '30' },
        { id: 'math_ss1_q5_c', text: '35' },
        { id: 'math_ss1_q5_d', text: '40' },
      ],
    },
    {
      id: 'math_ss1_q6', subjectId: 'math', classLevel: 'SS1', difficulty: 2,
      questionText: 'If y = 2x + 3, what is y when x = 4?',
      correctAnswerId: 'math_ss1_q6_d',
      explanation: 'y = 2(4) + 3 = 11',
      options: [
        { id: 'math_ss1_q6_a', text: '8' },
        { id: 'math_ss1_q6_b', text: '9' },
        { id: 'math_ss1_q6_c', text: '10' },
        { id: 'math_ss1_q6_d', text: '11' },
      ],
    },
    {
      id: 'math_ss1_q7', subjectId: 'math', classLevel: 'SS1', difficulty: 1,
      questionText: 'Area of a rectangle with length 8cm and width 5cm?',
      correctAnswerId: 'math_ss1_q7_c',
      explanation: 'Area = 8 × 5 = 40 cm²',
      options: [
        { id: 'math_ss1_q7_a', text: '26 cm²' },
        { id: 'math_ss1_q7_b', text: '36 cm²' },
        { id: 'math_ss1_q7_c', text: '40 cm²' },
        { id: 'math_ss1_q7_d', text: '48 cm²' },
      ],
    },
    {
      id: 'math_ss1_q8', subjectId: 'math', classLevel: 'SS1', difficulty: 1,
      questionText: 'Simplify: 4x + 3x − 2x',
      correctAnswerId: 'math_ss1_q8_b',
      explanation: '(4 + 3 − 2)x = 5x',
      options: [
        { id: 'math_ss1_q8_a', text: '3x' },
        { id: 'math_ss1_q8_b', text: '5x' },
        { id: 'math_ss1_q8_c', text: '7x' },
        { id: 'math_ss1_q8_d', text: '9x' },
      ],
    },
    {
      id: 'math_ss1_q9', subjectId: 'math', classLevel: 'SS1', difficulty: 3,
      questionText: 'Next in sequence: 2, 6, 18, 54, …?',
      correctAnswerId: 'math_ss1_q9_c',
      explanation: 'Each term × 3: 54 × 3 = 162',
      options: [
        { id: 'math_ss1_q9_a', text: '108' },
        { id: 'math_ss1_q9_b', text: '144' },
        { id: 'math_ss1_q9_c', text: '162' },
        { id: 'math_ss1_q9_d', text: '216' },
      ],
    },
    {
      id: 'math_ss1_q10', subjectId: 'math', classLevel: 'SS1', difficulty: 2,
      questionText: 'If a = 3 and b = 4, what is a² + b²?',
      correctAnswerId: 'math_ss1_q10_c',
      explanation: '9 + 16 = 25',
      options: [
        { id: 'math_ss1_q10_a', text: '12' },
        { id: 'math_ss1_q10_b', text: '14' },
        { id: 'math_ss1_q10_c', text: '25' },
        { id: 'math_ss1_q10_d', text: '49' },
      ],
    },
    {
      id: 'math_ss1_q11', subjectId: 'math', classLevel: 'SS1', difficulty: 1,
      questionText: 'What is 25% of 80?',
      correctAnswerId: 'math_ss1_q11_b',
      explanation: '0.25 × 80 = 20',
      options: [
        { id: 'math_ss1_q11_a', text: '15' },
        { id: 'math_ss1_q11_b', text: '20' },
        { id: 'math_ss1_q11_c', text: '25' },
        { id: 'math_ss1_q11_d', text: '30' },
      ],
    },
    {
      id: 'math_ss1_q12', subjectId: 'math', classLevel: 'SS1', difficulty: 2,
      questionText: 'Solve for x: 5x − 3 = 2x + 9',
      correctAnswerId: 'math_ss1_q12_c',
      explanation: '3x = 12, x = 4',
      options: [
        { id: 'math_ss1_q12_a', text: '2' },
        { id: 'math_ss1_q12_b', text: '3' },
        { id: 'math_ss1_q12_c', text: '4' },
        { id: 'math_ss1_q12_d', text: '5' },
      ],
    },
    // ── English ───────────────────────────────────────────────────────────────
    {
      id: 'english_ss1_q1', subjectId: 'english', classLevel: 'SS1', difficulty: 1,
      questionText: 'Choose the correct spelling:',
      correctAnswerId: 'english_ss1_q1_b',
      explanation: '"Necessary" is the correct spelling',
      options: [
        { id: 'english_ss1_q1_a', text: 'Nessecary' },
        { id: 'english_ss1_q1_b', text: 'Necessary' },
        { id: 'english_ss1_q1_c', text: 'Necesary' },
        { id: 'english_ss1_q1_d', text: 'Necessery' },
      ],
    },
    {
      id: 'english_ss1_q2', subjectId: 'english', classLevel: 'SS1', difficulty: 1,
      questionText: 'What is the plural of "child"?',
      correctAnswerId: 'english_ss1_q2_c',
      explanation: '"Children" is the irregular plural of "child"',
      options: [
        { id: 'english_ss1_q2_a', text: 'Childs' },
        { id: 'english_ss1_q2_b', text: 'Childes' },
        { id: 'english_ss1_q2_c', text: 'Children' },
        { id: 'english_ss1_q2_d', text: 'Childrens' },
      ],
    },
    {
      id: 'english_ss1_q3', subjectId: 'english', classLevel: 'SS1', difficulty: 2,
      questionText: 'Identify the verb in: "The dog barked loudly."',
      correctAnswerId: 'english_ss1_q3_b',
      explanation: '"Barked" is the action verb in this sentence',
      options: [
        { id: 'english_ss1_q3_a', text: 'dog' },
        { id: 'english_ss1_q3_b', text: 'barked' },
        { id: 'english_ss1_q3_c', text: 'loudly' },
        { id: 'english_ss1_q3_d', text: 'the' },
      ],
    },
    {
      id: 'english_ss1_q4', subjectId: 'english', classLevel: 'SS1', difficulty: 2,
      questionText: 'Which sentence is grammatically correct?',
      correctAnswerId: 'english_ss1_q4_a',
      explanation: 'Subject-verb agreement: "She" takes "is"',
      options: [
        { id: 'english_ss1_q4_a', text: 'She is going to school.' },
        { id: 'english_ss1_q4_b', text: 'She are going to school.' },
        { id: 'english_ss1_q4_c', text: 'She were going to school.' },
        { id: 'english_ss1_q4_d', text: 'She be going to school.' },
      ],
    },
    {
      id: 'english_ss1_q5', subjectId: 'english', classLevel: 'SS1', difficulty: 1,
      questionText: 'What is a synonym for "happy"?',
      correctAnswerId: 'english_ss1_q5_c',
      explanation: '"Joyful" means feeling or expressing great happiness',
      options: [
        { id: 'english_ss1_q5_a', text: 'Sad' },
        { id: 'english_ss1_q5_b', text: 'Angry' },
        { id: 'english_ss1_q5_c', text: 'Joyful' },
        { id: 'english_ss1_q5_d', text: 'Tired' },
      ],
    },
    {
      id: 'english_ss1_q6', subjectId: 'english', classLevel: 'SS1', difficulty: 2,
      questionText: 'The opposite of "ancient" is:',
      correctAnswerId: 'english_ss1_q6_b',
      explanation: '"Modern" means relating to present or recent times',
      options: [
        { id: 'english_ss1_q6_a', text: 'Old' },
        { id: 'english_ss1_q6_b', text: 'Modern' },
        { id: 'english_ss1_q6_c', text: 'Historical' },
        { id: 'english_ss1_q6_d', text: 'Antique' },
      ],
    },
    {
      id: 'english_ss1_q7', subjectId: 'english', classLevel: 'SS1', difficulty: 1,
      questionText: 'Which word is an adjective in: "The tall man walked slowly"?',
      correctAnswerId: 'english_ss1_q7_b',
      explanation: '"Tall" describes the noun "man" — it\'s an adjective',
      options: [
        { id: 'english_ss1_q7_a', text: 'walked' },
        { id: 'english_ss1_q7_b', text: 'tall' },
        { id: 'english_ss1_q7_c', text: 'slowly' },
        { id: 'english_ss1_q7_d', text: 'man' },
      ],
    },
    {
      id: 'english_ss1_q8', subjectId: 'english', classLevel: 'SS1', difficulty: 3,
      questionText: 'Identify the figure of speech: "The wind whispered through the trees."',
      correctAnswerId: 'english_ss1_q8_a',
      explanation: 'Giving human qualities (whispering) to a non-human (wind) is personification',
      options: [
        { id: 'english_ss1_q8_a', text: 'Personification' },
        { id: 'english_ss1_q8_b', text: 'Simile' },
        { id: 'english_ss1_q8_c', text: 'Metaphor' },
        { id: 'english_ss1_q8_d', text: 'Hyperbole' },
      ],
    },
    {
      id: 'english_ss1_q9', subjectId: 'english', classLevel: 'SS1', difficulty: 2,
      questionText: '"She runs _____ than her brother." Fill in the blank:',
      correctAnswerId: 'english_ss1_q9_c',
      explanation: 'Comparative form of "fast" is "faster"',
      options: [
        { id: 'english_ss1_q9_a', text: 'fast' },
        { id: 'english_ss1_q9_b', text: 'fastest' },
        { id: 'english_ss1_q9_c', text: 'faster' },
        { id: 'english_ss1_q9_d', text: 'more fast' },
      ],
    },
    {
      id: 'english_ss1_q10', subjectId: 'english', classLevel: 'SS1', difficulty: 2,
      questionText: 'Which sentence uses the past tense correctly?',
      correctAnswerId: 'english_ss1_q10_b',
      explanation: '"Went" is the past tense of "go"',
      options: [
        { id: 'english_ss1_q10_a', text: 'She go to the market yesterday.' },
        { id: 'english_ss1_q10_b', text: 'She went to the market yesterday.' },
        { id: 'english_ss1_q10_c', text: 'She goes to the market yesterday.' },
        { id: 'english_ss1_q10_d', text: 'She going to the market yesterday.' },
      ],
    },
    // ── Physics ───────────────────────────────────────────────────────────────
    {
      id: 'physics_ss1_q1', subjectId: 'physics', classLevel: 'SS1', difficulty: 1,
      questionText: 'What is the SI unit of force?',
      correctAnswerId: 'physics_ss1_q1_b',
      explanation: 'Force is measured in Newtons (N), named after Isaac Newton',
      options: [
        { id: 'physics_ss1_q1_a', text: 'Joule' },
        { id: 'physics_ss1_q1_b', text: 'Newton' },
        { id: 'physics_ss1_q1_c', text: 'Watt' },
        { id: 'physics_ss1_q1_d', text: 'Pascal' },
      ],
    },
    {
      id: 'physics_ss1_q2', subjectId: 'physics', classLevel: 'SS1', difficulty: 2,
      questionText: 'A car travels 120km in 2 hours. What is its average speed?',
      correctAnswerId: 'physics_ss1_q2_c',
      explanation: 'Speed = Distance ÷ Time = 120 ÷ 2 = 60 km/h',
      options: [
        { id: 'physics_ss1_q2_a', text: '40 km/h' },
        { id: 'physics_ss1_q2_b', text: '50 km/h' },
        { id: 'physics_ss1_q2_c', text: '60 km/h' },
        { id: 'physics_ss1_q2_d', text: '70 km/h' },
      ],
    },
    {
      id: 'physics_ss1_q3', subjectId: 'physics', classLevel: 'SS1', difficulty: 1,
      questionText: 'Which of these is NOT a vector quantity?',
      correctAnswerId: 'physics_ss1_q3_d',
      explanation: 'Speed has magnitude only (no direction), so it is a scalar, not a vector',
      options: [
        { id: 'physics_ss1_q3_a', text: 'Velocity' },
        { id: 'physics_ss1_q3_b', text: 'Force' },
        { id: 'physics_ss1_q3_c', text: 'Acceleration' },
        { id: 'physics_ss1_q3_d', text: 'Speed' },
      ],
    },
    {
      id: 'physics_ss1_q4', subjectId: 'physics', classLevel: 'SS1', difficulty: 2,
      questionText: 'Newton\'s first law states that a body at rest will:',
      correctAnswerId: 'physics_ss1_q4_a',
      explanation: 'A body remains at rest unless acted upon by an external force (inertia)',
      options: [
        { id: 'physics_ss1_q4_a', text: 'Remain at rest unless a force acts on it' },
        { id: 'physics_ss1_q4_b', text: 'Accelerate continuously' },
        { id: 'physics_ss1_q4_c', text: 'Move in a circle' },
        { id: 'physics_ss1_q4_d', text: 'Gain mass over time' },
      ],
    },
    {
      id: 'physics_ss1_q5', subjectId: 'physics', classLevel: 'SS1', difficulty: 1,
      questionText: 'What is the unit of electrical current?',
      correctAnswerId: 'physics_ss1_q5_b',
      explanation: 'Electrical current is measured in Amperes (A)',
      options: [
        { id: 'physics_ss1_q5_a', text: 'Volt' },
        { id: 'physics_ss1_q5_b', text: 'Ampere' },
        { id: 'physics_ss1_q5_c', text: 'Ohm' },
        { id: 'physics_ss1_q5_d', text: 'Watt' },
      ],
    },
    {
      id: 'physics_ss1_q6', subjectId: 'physics', classLevel: 'SS1', difficulty: 2,
      questionText: 'What happens to pressure when depth in a liquid increases?',
      correctAnswerId: 'physics_ss1_q6_a',
      explanation: 'Pressure increases with depth: P = ρgh',
      options: [
        { id: 'physics_ss1_q6_a', text: 'Pressure increases' },
        { id: 'physics_ss1_q6_b', text: 'Pressure decreases' },
        { id: 'physics_ss1_q6_c', text: 'Pressure stays the same' },
        { id: 'physics_ss1_q6_d', text: 'Pressure becomes zero' },
      ],
    },
    {
      id: 'physics_ss1_q7', subjectId: 'physics', classLevel: 'SS1', difficulty: 1,
      questionText: 'Which form of energy does a moving car possess?',
      correctAnswerId: 'physics_ss1_q7_b',
      explanation: 'A moving object has kinetic energy due to its motion',
      options: [
        { id: 'physics_ss1_q7_a', text: 'Potential energy' },
        { id: 'physics_ss1_q7_b', text: 'Kinetic energy' },
        { id: 'physics_ss1_q7_c', text: 'Chemical energy' },
        { id: 'physics_ss1_q7_d', text: 'Nuclear energy' },
      ],
    },
    {
      id: 'physics_ss1_q8', subjectId: 'physics', classLevel: 'SS1', difficulty: 2,
      questionText: 'What is the relationship between frequency and wavelength?',
      correctAnswerId: 'physics_ss1_q8_c',
      explanation: 'As frequency increases, wavelength decreases (they are inversely proportional)',
      options: [
        { id: 'physics_ss1_q8_a', text: 'Directly proportional' },
        { id: 'physics_ss1_q8_b', text: 'No relationship' },
        { id: 'physics_ss1_q8_c', text: 'Inversely proportional' },
        { id: 'physics_ss1_q8_d', text: 'Exponential relationship' },
      ],
    },
    {
      id: 'physics_ss1_q9', subjectId: 'physics', classLevel: 'SS1', difficulty: 1,
      questionText: 'What instrument measures atmospheric pressure?',
      correctAnswerId: 'physics_ss1_q9_a',
      explanation: 'A barometer measures atmospheric pressure',
      options: [
        { id: 'physics_ss1_q9_a', text: 'Barometer' },
        { id: 'physics_ss1_q9_b', text: 'Thermometer' },
        { id: 'physics_ss1_q9_c', text: 'Manometer' },
        { id: 'physics_ss1_q9_d', text: 'Altimeter' },
      ],
    },
    {
      id: 'physics_ss1_q10', subjectId: 'physics', classLevel: 'SS1', difficulty: 3,
      questionText: 'An object of mass 5kg is lifted 3m high. What is its potential energy? (g = 10 m/s²)',
      correctAnswerId: 'physics_ss1_q10_b',
      explanation: 'PE = mgh = 5 × 10 × 3 = 150 J',
      options: [
        { id: 'physics_ss1_q10_a', text: '50 J' },
        { id: 'physics_ss1_q10_b', text: '150 J' },
        { id: 'physics_ss1_q10_c', text: '300 J' },
        { id: 'physics_ss1_q10_d', text: '450 J' },
      ],
    },
  ];
}