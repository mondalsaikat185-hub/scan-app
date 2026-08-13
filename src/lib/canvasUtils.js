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
