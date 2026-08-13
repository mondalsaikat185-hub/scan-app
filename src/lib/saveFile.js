/**
 * PDF সেভ করা — যেখানে সম্ভব ইউজারকে ফোল্ডার ও নাম বেছে নিতে দেয়।
 *
 * ব্রাউজারভেদে সামর্থ্য আলাদা:
 *  • ডেস্কটপ Chrome/Edge — File System Access API আছে, তাই আসল
 *    "Save As" ডায়ালগ খোলে: ইউজার ডিরেক্টরি ও নাম দুটোই ঠিক করে।
 *  • Android/iOS ব্রাউজার — এই API নেই। সেখানে সাধারণ ডাউনলোড হয়
 *    (ব্রাউজারের সেটিংয়ে "প্রতিবার জিজ্ঞেস করো" চালু থাকলে ফোনও
 *    ফোল্ডার জিজ্ঞেস করে), অথবা Share দিয়ে Files/Drive-এ পাঠানো যায়।
 */

export function canPickLocation() {
  return typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function';
}

function sanitize(name) {
  return (name || 'document').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'document';
}

/**
 * @returns {'saved'|'downloaded'|'cancelled'}
 */
export async function savePdfBlob(blob, name) {
  const fileName = `${sanitize(name)}.pdf`;

  if (canPickLocation()) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: fileName,
        types: [{ description: 'PDF document', accept: { 'application/pdf': ['.pdf'] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return 'saved';
    } catch (err) {
      if (err && err.name === 'AbortError') return 'cancelled';
      console.warn('Save picker failed, falling back to download', err);
    }
  }

  // ফলব্যাক — সাধারণ ডাউনলোড
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return 'downloaded';
}
