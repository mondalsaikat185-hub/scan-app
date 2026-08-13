export const MAX_DIM = 2600;

export function scaleCanvas(canvas) {
  let width = canvas.width;
  let height = canvas.height;
  const longSide = Math.max(width, height);
  if (longSide > MAX_DIM) {
    const s = MAX_DIM / longSide;
    width = Math.round(width * s);
    height = Math.round(height * s);
    
    const scaled = document.createElement('canvas');
    scaled.width = width;
    scaled.height = height;
    scaled.getContext('2d').drawImage(canvas, 0, 0, width, height);
    return scaled;
  }
  return canvas;
}

// Helper to create Blobs from canvases based on filter
export function canvasToBlob(canvas, filter) {
  const isColor = filter === 'original' || filter === 'magic';
  const type = isColor ? 'image/jpeg' : 'image/png';
  const quality = isColor ? 0.95 : undefined;
  
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), type, quality);
  });
}

// এক্সপোর্টের মান — ইউজার বেছে নিতে পারে
export const QUALITY_PRESETS = {
  high:   { label: 'High',   maxDim: 2600, jpeg: 0.95 },
  medium: { label: 'Medium', maxDim: 1800, jpeg: 0.85 },
  small:  { label: 'Small',  maxDim: 1200, jpeg: 0.72 },
};

// একটা Blob-কে নির্দিষ্ট মানে ছোট করা (PDF ফাইল সাইজ কমাতে)
export async function downscaleBlob(blob, preset) {
  const p = QUALITY_PRESETS[preset] || QUALITY_PRESETS.high;
  const bmp = await createImageBitmap(blob);
  const long = Math.max(bmp.width, bmp.height);
  const k = Math.min(1, p.maxDim / long);
  if (k === 1 && preset === 'high') { bmp.close(); return blob; }

  const w = Math.max(1, Math.round(bmp.width * k));
  const h = Math.max(1, Math.round(bmp.height * k));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').drawImage(bmp, 0, 0, w, h);
  bmp.close();

  // সাদা-কালো স্ক্যান PNG-তেই crisp থাকে; কালার ছবিতে JPEG ছোট হয়
  const isPng = blob.type === 'image/png';
  return new Promise((res) => c.toBlob(
    (b) => res(b || blob),
    isPng && preset === 'high' ? 'image/png' : 'image/jpeg',
    p.jpeg
  ));
}

// Blob → canvas (re-edit এর জন্য আসল ছবি ফিরিয়ে আনতে)
export async function blobToCanvas(blob) {
  const bmp = await createImageBitmap(blob);
  const c = document.createElement('canvas');
  c.width = bmp.width; c.height = bmp.height;
  c.getContext('2d', { willReadFrequently: true }).drawImage(bmp, 0, 0);
  bmp.close();
  return c;
}

// আসল (অপ্রক্রিয়াজাত) ছবি সংরক্ষণের জন্য — মাঝারি JPEG, যাতে স্টোরেজ না ফোলে
export function originalBlobOf(canvas) {
  return new Promise((res) => canvas.toBlob((b) => res(b), 'image/jpeg', 0.88));
}

/**
 * canvas-কে ৯০°-এর গুণিতকে ঘোরানো (০/৯০/১৮০/২৭০)।
 * কোনো ইন্টারপোলেশন হয় না, তাই একটুও কোয়ালিটি নষ্ট হয় না।
 */
export function rotateCanvas(src, deg) {
  const d = ((deg % 360) + 360) % 360;
  if (d === 0) return src;
  const swap = (d === 90 || d === 270);
  const out = document.createElement('canvas');
  out.width = swap ? src.height : src.width;
  out.height = swap ? src.width : src.height;
  const ctx = out.getContext('2d');
  ctx.translate(out.width / 2, out.height / 2);
  ctx.rotate((d * Math.PI) / 180);
  ctx.drawImage(src, -src.width / 2, -src.height / 2);
  return out;
}

// Blob → ঘোরানো Blob (PageReview থেকে সরাসরি পেজ ঘোরাতে)
export async function rotateBlob(blob, deg) {
  const c = await blobToCanvas(blob);
  const r = rotateCanvas(c, deg);
  const isPng = blob.type === 'image/png';
  return new Promise((res) => r.toBlob((b) => res(b || blob),
    isPng ? 'image/png' : 'image/jpeg', isPng ? undefined : 0.95));
}
