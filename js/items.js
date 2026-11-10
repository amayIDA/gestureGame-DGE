// Item catalogue — images extracted from the Figma storyboard ("What to catch" screen).
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const CATCH = ['Statistics', 'Data', 'Census', 'Surveys', 'Population', 'Economy',
  'Research', 'Analytics', 'Indicators', 'Reports', 'Charts', 'Growth',
  'Dashboards', 'Geo Maps', 'E-Survey', 'Computing', 'Questionnaire', 'Data Servers',
  'Field Research', 'Insights', 'Targets', 'Methods', 'Sampling', 'Satellite Data',
  'Building Blocks', 'Intelligence', 'Records', 'Sustainability', 'Global Data', 'Abu Dhabi'];

const AVOID = ['Frying Pan', 'Perfume', 'Suitcase', 'Tennis Racket', 'Toothbrush', 'Guitar',
  'Hair Dryer', 'Sunglasses', 'Toaster', 'Necklace', 'Sneakers', 'Camera Lens',
  'Coffee Grinder', 'Sewing Machine', 'Umbrella', 'Wristwatch', 'House Plant', 'Bicycle',
  'Oven Mitt', 'Soap', 'Keys', 'Candle', 'Measuring Cup', 'Paint Roller',
  'Hanger', 'Yoga Mat', 'Watering Can', 'Spatula', 'Nail Polish', 'Pillow'];

const build = (names, kind) => names.map((label, i) => {
  const n = String(i + 1).padStart(2, '0');
  return { id: `${kind}-${n}`, kind, label, src: `assets/items/${kind}/${n}-${slug(label)}.png` };
});

export const CATCH_ITEMS = build(CATCH, 'catch');
export const AVOID_ITEMS = build(AVOID, 'avoid');
export const ALL_ITEMS = [...CATCH_ITEMS, ...AVOID_ITEMS];

export const UI = {
  background: 'assets/ui/background.jpg',
  title: 'assets/ui/title-catch-the-target.png',
};
