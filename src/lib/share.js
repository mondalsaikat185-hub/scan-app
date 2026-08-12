import { makePdfFromPages } from './makePdf';

// PDF তৈরি করে শেয়ার করে; শেয়ার সম্ভব না হলে ডাউনলোড ফলব্যাক
export async function sharePdf(pages, name) {
  if (!pages || pages.length === 0) return;

  const blob = await makePdfFromPages(pages);
  const fileName = `${(name || 'document').replace(/[^\w\-]+/g, '_')}.pdf`;
  const file = new File([blob], fileName, { type: 'application/pdf' });

  // 1. Native File Share (Mobile)
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({
        files: [file],
        title: name || 'Scanned Document',
        text: 'Scanned with Scan App',
      });
      return 'shared';
    } catch (err) {
      // User cancelled
      if (err.name === 'AbortError') return 'cancelled';
      console.warn('Share failed, falling back to download', err);
    }
  }

  // 2. Fallback - Download
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  return 'downloaded';
}
