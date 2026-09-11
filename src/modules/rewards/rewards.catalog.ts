/// The reward catalogue is a small fixed list, not a DB table - there's no
/// admin-authoring UI for it yet. Mirrors the mobile app's `mockRewards`
/// (id/title/subtitle/coinCost); icon/color stay client-side.
export interface RewardCatalogItem {
  id: string;
  title: string;
  subtitle: string;
  coinCost: number;
}

export const REWARDS_CATALOG: RewardCatalogItem[] = [
  { id: 'airtime_500', title: 'Airtime', subtitle: 'N500', coinCost: 500 },
  { id: 'data_1gb', title: 'Data Bundle', subtitle: '1GB', coinCost: 800 },
  { id: 'edu_books', title: 'Edu Books', subtitle: 'E-Book', coinCost: 1200 },
  { id: 'exam_voucher', title: 'Exam Voucher', subtitle: 'WAEC', coinCost: 1500 },
  { id: 'laptop', title: 'Laptop', subtitle: 'HP 14"', coinCost: 25000 },
  { id: 'scholarship', title: 'Scholarship', subtitle: 'University', coinCost: 50000 },
];
