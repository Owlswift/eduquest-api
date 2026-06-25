import "dotenv/config";
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const connectionString = process.env.DATABASE_URL;
const adapter = new PrismaPg(connectionString!);
const prisma = new PrismaClient({ adapter });

async function main() {
  const subjects = [
    // Core Subjects
    { id: 'math', name: 'Mathematics', icon: 'functions_rounded', color: '#FF4F46E5', currentTopic: 'Algebra' },
    { id: 'english', name: 'English Language', icon: 'menu_book_rounded', color: '#FF7C3AED', currentTopic: 'Grammar' },
    { id: 'further_math', name: 'Further Mathematics', icon: 'calculate_rounded', color: '#FF6366F1', currentTopic: 'Calculus' },
    
    // Sciences
    { id: 'physics', name: 'Physics', icon: 'science_rounded', color: '#FF0EA5E9', currentTopic: 'Mechanics' },
    { id: 'chemistry', name: 'Chemistry', icon: 'biotech_rounded', color: '#FF8B5CF6', currentTopic: 'Atomic Structure' },
    { id: 'biology', name: 'Biology', icon: 'eco_rounded', color: '#FF22C55E', currentTopic: 'Cell Biology' },
    { id: 'agricultural_science', name: 'Agricultural Science', icon: 'agriculture_rounded', color: '#FF16A34A', currentTopic: 'Crop Production' },
    
    // Commercial / Business
    { id: 'economics', name: 'Economics', icon: 'trending_up_rounded', color: '#FFF97316', currentTopic: 'Supply & Demand' },
    { id: 'commerce', name: 'Commerce', icon: 'storefront_rounded', color: '#FFF59E0B', currentTopic: 'Trade' },
    { id: 'accounting', name: 'Financial Accounting', icon: 'account_balance_wallet_rounded', color: '#FF0891B2', currentTopic: 'Ledger Accounts' },
    
    // Arts & Humanities
    { id: 'government', name: 'Government', icon: 'account_balance_rounded', color: '#FF3B82F6', currentTopic: 'Nigerian Constitution' },
    { id: 'literature', name: 'Literature in English', icon: 'auto_stories_rounded', color: '#FFEF4444', currentTopic: 'Poetry' },
    { id: 'history', name: 'History', icon: 'history_edu_rounded', color: '#FFB45309', currentTopic: 'Pre-Colonial Nigeria' },
    { id: 'crs', name: 'Christian Religious Studies', icon: 'church_rounded', color: '#FFDC2626', currentTopic: 'The Ministry of Jesus' },
    { id: 'irs', name: 'Islamic Religious Studies', icon: 'mosque_rounded', color: '#FF059669', currentTopic: 'The Five Pillars of Islam' },
    { id: 'civic_education', name: 'Civic Education', icon: 'groups_rounded', color: '#FF2563EB', currentTopic: 'Citizenship' },
    { id: 'geography', name: 'Geography', icon: 'public_rounded', color: '#FF0D9488', currentTopic: 'Physical Environment' },
    
    // Technology & Vocational
    { id: 'computer_studies', name: 'Computer Studies', icon: 'computer_rounded', color: '#FF4F46E5', currentTopic: 'Computer Systems' },
    { id: 'ict', name: 'Information Technology', icon: 'devices_rounded', color: '#FF4338CA', currentTopic: 'Internet Technology' },
    { id: 'technical_drawing', name: 'Technical Drawing', icon: 'architecture_rounded', color: '#FF475569', currentTopic: 'Orthographic Projection' },
    
    // Languages
    { id: 'yoruba', name: 'Yoruba', icon: 'translate_rounded', color: '#FFEA580C', currentTopic: 'Oral Tradition' },
    { id: 'igbo', name: 'Igbo', icon: 'translate_rounded', color: '#FF16A34A', currentTopic: 'Grammar' },
    { id: 'hausa', name: 'Hausa', icon: 'translate_rounded', color: '#FFCA8A04', currentTopic: 'Language Structure' },
    
    // General
    { id: 'marketing', name: 'Marketing', icon: 'campaign_rounded', color: '#FFE11D48', currentTopic: 'Marketing Concepts' },
    { id: 'business_studies', name: 'Business Studies', icon: 'business_center_rounded', color: '#FF7C2D12', currentTopic: 'Entrepreneurship' },
  ];

  for (const subject of subjects) {
    await prisma.subject.upsert({
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

  console.log(`Seeded ${subjects.length} subjects successfully`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });