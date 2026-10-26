/**
 * The achievement catalogue (PRODUCT.md section 8.4). Unlocks are decided on
 * the server from verified data only; `UserAchievement` records that one was
 * earned. `icon` names an illustration in the design system's assets.
 */
export type AchievementStat =
  | 'quizzes'
  | 'questionsAnswered'
  | 'correctAnswers'
  | 'perfectQuizzes'
  | 'longestStreak'
  | 'level'
  | 'challengesWon'
  | 'certificates';

export interface AchievementDef {
  key: string;
  name: string;
  description: string;
  icon: string;
  stat: AchievementStat;
  target: number;
  rewardXp: number;
  rewardCoins: number;
}

export type AchievementStats = Record<AchievementStat, number>;

export const ACHIEVEMENTS: AchievementDef[] = [
  { key: 'first_steps', name: 'First Steps', description: 'Finish your first quiz', icon: 'level1_badge', stat: 'quizzes', target: 1, rewardXp: 20, rewardCoins: 10 },
  { key: 'century', name: 'Century', description: 'Answer 100 questions', icon: 'bronze_medal', stat: 'questionsAnswered', target: 100, rewardXp: 50, rewardCoins: 20 },
  { key: 'five_hundred', name: 'Five Hundred', description: 'Answer 500 questions', icon: 'silver', stat: 'questionsAnswered', target: 500, rewardXp: 150, rewardCoins: 50 },
  { key: 'quiz_master', name: 'Quiz Master', description: 'Get 250 answers right', icon: 'gold_medal', stat: 'correctAnswers', target: 250, rewardXp: 100, rewardCoins: 50 },
  { key: 'sharpshooter', name: 'Sharpshooter', description: 'Get every question right in a quiz of 5 or more', icon: 'today_target', stat: 'perfectQuizzes', target: 1, rewardXp: 40, rewardCoins: 20 },
  { key: 'streak_7', name: 'Seven Day Streak', description: 'Study 7 days in a row', icon: 'gold_medal', stat: 'longestStreak', target: 7, rewardXp: 100, rewardCoins: 50 },
  { key: 'streak_30', name: 'Thirty Day Streak', description: 'Study 30 days in a row', icon: 'trophy', stat: 'longestStreak', target: 30, rewardXp: 400, rewardCoins: 200 },
  { key: 'level_3', name: 'Climber', description: 'Reach level 3', icon: 'level1_badge', stat: 'level', target: 3, rewardXp: 0, rewardCoins: 50 },
  { key: 'level_5', name: 'Champion', description: 'Reach level 5', icon: 'trophy', stat: 'level', target: 5, rewardXp: 0, rewardCoins: 150 },
  { key: 'challenge_ace', name: 'Challenge Ace', description: 'Win a 1v1 challenge', icon: 'crossed_swords', stat: 'challengesWon', target: 1, rewardXp: 50, rewardCoins: 20 },
  { key: 'challenge_champion', name: 'Challenge Champion', description: 'Win 10 challenges', icon: 'crossed_swords', stat: 'challengesWon', target: 10, rewardXp: 200, rewardCoins: 100 },
  { key: 'topic_expert', name: 'Topic Expert', description: 'Earn a subject certificate', icon: 'gold_medal', stat: 'certificates', target: 1, rewardXp: 100, rewardCoins: 50 },
];
