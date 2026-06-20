import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';

@Injectable()
export class UsersService {
  constructor(private prisma: PrismaService) {}

  async findById(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        fullName: true,
        username: true,
        email: true,
        avatarUrl: true,
        classLevel: true,
        level: true,
        coins: true,
        xp: true,
        maxXp: true,
        badges: true,
        certificates: true,
        streak: true,
        questionsAnswered: true,
        accuracy: true,
        timeSpent: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!user) {
      throw new Error('User not found');
    }

    return user;
  }
}