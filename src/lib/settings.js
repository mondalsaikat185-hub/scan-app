/**
 * স্বয়ংক্রিয় সংশোধনের সেটিংস।
 *
 * ডিফল্ট বাছাইয়ের যুক্তি — যেটা পরীক্ষায় প্রমাণিত, সেটাই চালু:
 *   • deskew  — পরীক্ষিত: ±৬° পর্যন্ত হেলানো লেখা ঘুরিয়ে অবশিষ্ট ০°  → ON
 *   • a4      — সুরক্ষা যোগ করার পর কোণার নড়াচড়ায় বিচ্যুতি ০%        → ON
 *   • unshear — ছন্নছাড়া/মাঝবরাবর লেখায় ভুল করতে পারে                → OFF
 *   • trim    — কখনো লেখার ধার কেটে দিতে পারে                        → OFF
 *   • gutter  — শুধু বইয়ের ভাঁজে দরকার, নাহলে ক্ষতি                   → OFF
 *
 * ইউজার চাইলে যেকোনোটা চালু করতে পারেন — কিন্তু ডিফল্ট থাকে নিরাপদ ও
 * অনুমানযোগ্য, কারণ অনেকগুলো অনুমান একসাথে চাপালে ফল অনিশ্চিত হয়ে যায়।
 */
const KEY = 'scan-corrections';

export const DEFAULT_CORRECTIONS = {
  deskew: true,
  a4: true,
  whiten: true,
  unshear: false,
  trim: false,
  gutter: false,
};

export function loadCorrections() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_CORRECTIONS };
    return { ...DEFAULT_CORRECTIONS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_CORRECTIONS };
  }
}

export function saveCorrections(c) {
  try { localStorage.setItem(KEY, JSON.stringify(c)); } catch { /* ignore */ }
}

export const CORRECTION_LABELS = {
  whiten:  { title: 'কাগজ পরিষ্কার',       desc: 'ভাঁজ/ছোপ/শেড মুছে খাঁটি সাদা (পরীক্ষিত)' },
  deskew:  { title: 'লেখা সোজা করা',     desc: 'বাঁকা লাইন অনুভূমিক করে (পরীক্ষিত)' },
  a4:      { title: 'A4 অনুপাতে বসানো',  desc: 'প্রিন্টের জন্য মানানসই মাপ' },
  unshear: { title: 'হেলানো ব্লক সোজা',   desc: 'লেখা পাশে সরে গেলে — মাঝে মাঝে ভুল করে' },
  trim:    { title: 'ধার ছাঁটাই',          desc: 'বাইরের ফালি বাদ — কখনো বেশি কেটে ফেলে' },
  gutter:  { title: 'বইয়ের ভাঁজ কাটা',    desc: 'খোলা বইয়ের এক পাতা নিতে' },
};
