import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';

export interface SubjectDto {
  id: string;
  name: string;
  icon: string;
  color: string;
  currentTopic?: string;
  progress: number;
}

@Injectable()
export class SubjectsService {
  constructor(private prisma: PrismaService) {}

  async findAll(): Promise<SubjectDto[]> {
    const subjects = await this.prisma.subject.findMany({
      orderBy: { name: 'asc' },
    });

    return subjects.map((subject) => ({
      id: subject.id,
      name: subject.name,
      icon: subject.icon,
      color: subject.color,
      currentTopic: subject.currentTopic || undefined,
      progress: subject.progress,
    }));
  }

  async findById(id: string) {
    const subject = await this.prisma.subject.findUnique({
      where: { id },
    });

    if (!subject) return null;

    return {
      id: subject.id,
      name: subject.name,
      icon: subject.icon,
      color: subject.color,
      currentTopic: subject.currentTopic || undefined,
      progress: subject.progress,
    };
  }

  async seedSubjects() {
    const subjects = [
      { id: 'math', name: 'Mathematics', icon: 'functions_rounded', color: '#FF4F46E5', currentTopic: 'Algebra' },
      { id: 'english', name: 'English', icon: 'menu_book_rounded', color: '#FF7C3AED', currentTopic: 'Grammar' },
      { id: 'physics', name: 'Physics', icon: 'science_rounded', color: '#FF0EA5E9', currentTopic: 'Mechanics' },
      { id: 'chemistry', name: 'Chemistry', icon: 'biotech_rounded', color: '#FF8B5CF6', currentTopic: 'Atomic Structure' },
      { id: 'biology', name: 'Biology', icon: 'eco_rounded', color: '#FF22C55E', currentTopic: 'Cell Biology' },
      { id: 'economics', name: 'Economics', icon: 'trending_up_rounded', color: '#FFF97316', currentTopic: 'Supply & Demand' },
      { id: 'government', name: 'Government', icon: 'account_balance_rounded', color: '#FF3B82F6', currentTopic: 'Nigerian Constitution' },
      { id: 'literature', name: 'Literature', icon: 'auto_stories_rounded', color: '#FFEF4444', currentTopic: 'Poetry' },
      { id: 'further_math', name: 'Further Math', icon: 'calculate_rounded', color: '#FF6366F1', currentTopic: 'Calculus' },
    ];

    for (const subject of subjects) {
      await this.prisma.subject.upsert({
        where: { id: subject.id },
        update: {
          name: subject.name,
          icon: subject.icon,
          color: subject.color,
          currentTopic: subject.currentTopic,
        },
        create: subject,
      });
    }

    return { message: 'Subjects seeded successfully', count: subjects.length };
  }
}