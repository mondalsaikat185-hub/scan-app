import { PDFDocument } from 'pdf-lib';
import { downscaleBlob, rotateBlob } from './canvasUtils';

// A4 @ 72dpi (PDF point) — 210mm × 297mm
export const A4_W = 595.276;
export const A4_H = 841.890;

/**
 * ছবিটাকে A4 পেজে বসানোর হিসাব।
 * ছবির অনুপাত অক্ষত রেখে (contain) পুরো পেজে যতটা সম্ভব বড় করে, মাঝখানে।
 * ছবি চওড়া হলে A4 ল্যান্ডস্কেপ ব্যবহার হয় — কাগজ A4-ই থাকে, শুধু ঘোরানো।
 */
function fitOnA4(imgW, imgH, marginPt = 0) {
  const landscape = imgW > imgH;
  const pageW = landscape ? A4_H : A4_W;
  const pageH = landscape ? A4_W : A4_H;

  const availW = pageW - marginPt * 2;
  const availH = pageH - marginPt * 2;
  const scale = Math.min(availW / imgW, availH / imgH);

  const drawW = imgW * scale;
  const drawH = imgH * scale;
  return {
    pageW, pageH,
    drawW, drawH,
    x: (pageW - drawW) / 2,
    y: (pageH - drawH) / 2,
  };
}

async function embed(pdfDoc, bytes, isPng) {
  return isPng ? pdfDoc.embedPng(bytes) : pdfDoc.embedJpg(bytes);
}

/** একটা canvas → এক-পাতার A4 PDF */
export async function makePdfBlob(canvas, filterType = 'scan') {
  const pdfDoc = await PDFDocument.create();
  const isColor = filterType === 'original' || filterType === 'magic';
  const dataUrl = isColor ? canvas.toDataURL('image/jpeg', 0.95) : canvas.toDataURL('image/png');
  const base64 = dataUrl.split(',')[1];
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

  const image = await embed(pdfDoc, bytes, !isColor);
  const f = fitOnA4(image.width, image.height);
  const page = pdfDoc.addPage([f.pageW, f.pageH]);
  page.drawImage(image, { x: f.x, y: f.y, width: f.drawW, height: f.drawH });

  const pdfBytes = await pdfDoc.save();
  return new Blob([pdfBytes], { type: 'application/pdf' });
}

/**
 * সব পেজ নিয়ে একটা মাল্টি-পেজ PDF — প্রতিটা পাতা ঠিক A4 মাপের,
 * তাই প্রিন্ট করার সময় স্কেলিং/কাটাকুটির সমস্যা হয় না।
 */
export async function makePdfFromPages(pages, quality = 'high', orientation = 'auto') {
  const pdfDoc = await PDFDocument.create();

  for (const p of pages) {
    let blob = quality === 'high' ? p.blob : await downscaleBlob(p.blob, quality);

    // 'portrait' মোডে সব পাতা লম্বালম্বি A4 — চওড়া ছবি ৯০° ঘুরিয়ে বসানো হয়,
    // যাতে ছাপার সময় সব কাগজ একই দিকে থাকে (কাগজ বদলাতে হয় না)।
    // 'auto' মোডে চওড়া ছবির জন্য A4 ল্যান্ডস্কেপ পাতা তৈরি হয়।
    if (orientation === 'portrait') {
      const probe = await createImageBitmap(blob);
      const wide = probe.width > probe.height;
      probe.close();
      if (wide) blob = await rotateBlob(blob, 90);
    }

    const bytes = new Uint8Array(await blob.arrayBuffer());
    const image = await embed(pdfDoc, bytes, blob.type === 'image/png');
    const f = fitOnA4(image.width, image.height);
    const page = pdfDoc.addPage([f.pageW, f.pageH]);
    page.drawImage(image, { x: f.x, y: f.y, width: f.drawW, height: f.drawH });
  }

  const pdfBytes = await pdfDoc.save();
  return new Blob([pdfBytes], { type: 'application/pdf' });
}
