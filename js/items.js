// Item catalogue — images extracted from the Figma storyboard ("What to catch" screen).
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const CATCH = ['Statistics', 'Data', 'Census', 'Surveys', 'Population', 'Economy', 'Research', 'Analysis', 'Indicators', 'Reports', 'Charts', 'Graphs', 'Dashboard', 'Maps', 'Tablet', 'Computer', 'Questionnaire', 'Database', 'Enumerator', 'Insights', 'Accuracy', 'Innovation', 'Bayaan', 'Suhail', 'Tbyaan', 'Ibdaa', 'Sijilat', 'Bayna', 'Data for Good', 'Abu Dhabi'];

const AVOID = ['Alarm Clock', 'Perfume', 'Suitcase', 'Tennis Racket', 'Toothbrush', 'Guitar', 'Hairdryer', 'Sunglasses', 'Toaster', 'Necklace', 'Running Shoes', 'Camera Lens', 'Coffee Grinder', 'Sewing Machine', 'Umbrella', 'Wristwatch', 'Plant Pot', 'Bicycle', 'Rain Boot', 'Soap Bar', 'Keyring', 'Candle', 'Measuring Cup', 'Paint Roller', 'Clothes Hanger', 'Basketball', 'Watering Can', 'Spatula', 'Nail Polish', 'Rubber Duck'];

const build = (names, kind) => names.map((label, i) => {
  const n = String(i + 1).padStart(2, '0');
  return { id: `${kind}-${n}`, kind, label, src: `assets/items/${kind}/${n}-${slug(label)}.png` };
});

export const CATCH_ITEMS = build(CATCH, 'catch');
export const AVOID_ITEMS = build(AVOID, 'avoid');
export const ALL_ITEMS = [...CATCH_ITEMS, ...AVOID_ITEMS];

export const UI = {
  background: 'assets/ui/background.mp4',
  backgroundPoster: 'assets/ui/background-poster.jpg',
  title: 'assets/ui/title-catch-the-target.png',
};
