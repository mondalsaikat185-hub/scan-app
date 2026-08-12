export function applyFilter(cv, sourceCanvas, filterType) {
  if (filterType === 'original') {
    return sourceCanvas;
  }

  let src = null;
  let dst = null;
  
  try {
    src = cv.imread(sourceCanvas);
    dst = new cv.Mat();

    if (filterType === 'grayscale') {
      cv.cvtColor(src, dst, cv.COLOR_RGBA2GRAY, 0);
    } 
    else if (filterType === 'scan') {
      // B&W Scan look (Adaptive Thresholding)
      cv.cvtColor(src, dst, cv.COLOR_RGBA2GRAY, 0);
      
      // Slight blur to remove high freq noise before threshold
      let ksize = new cv.Size(5, 5);
      cv.GaussianBlur(dst, dst, ksize, 0, 0, cv.BORDER_DEFAULT);

      // Adaptive threshold: blockSize=21, C=10 (tunable)
      cv.adaptiveThreshold(
        dst, 
        dst, 
        255, 
        cv.ADAPTIVE_THRESH_GAUSSIAN_C, 
        cv.THRESH_BINARY, 
        21, 
        10
      );
    }

    const outCanvas = document.createElement('canvas');
    outCanvas.width = sourceCanvas.width;
    outCanvas.height = sourceCanvas.height;
    cv.imshow(outCanvas, dst);
    
    return outCanvas;

  } catch (err) {
    console.error(`Error applying filter ${filterType}`, err);
    return sourceCanvas;
  } finally {
    if (src) src.delete();
    if (dst) dst.delete();
  }
}
