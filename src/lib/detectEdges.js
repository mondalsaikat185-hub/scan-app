export function detectEdges(cv, imgCanvas) {
  let src = null;
  let gray = null;
  let blur = null;
  let edges = null;
  let dilated = null;
  let contours = null;
  let hierarchy = null;
  let poly = null;

  try {
    src = cv.imread(imgCanvas);
    gray = new cv.Mat();
    blur = new cv.Mat();
    edges = new cv.Mat();
    dilated = new cv.Mat();
    contours = new cv.MatVector();
    hierarchy = new cv.Mat();
    poly = new cv.Mat();

    // 1. Grayscale
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY, 0);

    // 2. Gaussian Blur
    let ksize = new cv.Size(5, 5);
    cv.GaussianBlur(gray, blur, ksize, 0, 0, cv.BORDER_DEFAULT);

    // 3. Canny Edge Detection
    cv.Canny(blur, edges, 75, 200);

    // 4. Dilate
    let anchor = new cv.Point(-1, -1);
    let M = cv.Mat.ones(3, 3, cv.CV_8U);
    cv.dilate(edges, dilated, M, anchor, 1, cv.BORDER_CONSTANT, cv.morphologyDefaultBorderValue());
    M.delete();

    // 5. Find Contours
    cv.findContours(dilated, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    // 6 & 7. Find largest 4-sided contour
    let maxArea = 0;
    let bestPoly = null;

    for (let i = 0; i < contours.size(); ++i) {
      let cnt = contours.get(i);
      let area = cv.contourArea(cnt);
      
      if (area > 1000) { // filter out small noise
        let perimeter = cv.arcLength(cnt, true);
        cv.approxPolyDP(cnt, poly, 0.02 * perimeter, true);
        
        if (poly.rows === 4 && area > maxArea) {
          maxArea = area;
          
          if (bestPoly) bestPoly.delete();
          bestPoly = poly.clone();
        }
      }
      cnt.delete();
    }

    let points = [];
    if (bestPoly) {
      // Extract the 4 points
      for (let i = 0; i < 4; i++) {
        points.push({
          x: bestPoly.data32S[i * 2],
          y: bestPoly.data32S[i * 2 + 1]
        });
      }
      bestPoly.delete();

      // 8. Order points (top-left, top-right, bottom-right, bottom-left)
      points = orderPoints(points);
    } else {
      // 9. Default to full image bounds if no rectangle found
      const w = src.cols;
      const h = src.rows;
      // Provide a small margin (5%) so handles are visible
      const mx = w * 0.05;
      const my = h * 0.05;
      points = [
        { x: mx, y: my },
        { x: w - mx, y: my },
        { x: w - mx, y: h - my },
        { x: mx, y: h - my }
      ];
    }

    return points;
  } catch (err) {
    console.error("Error in edge detection", err);
    // Fallback to default full frame
    const w = imgCanvas.width;
    const h = imgCanvas.height;
    return [
      { x: 0, y: 0 },
      { x: w, y: 0 },
      { x: w, y: h },
      { x: 0, y: h }
    ];
  } finally {
    // 10. IMPORTANT: Memory management for OpenCV.js
    if (src) src.delete();
    if (gray) gray.delete();
    if (blur) blur.delete();
    if (edges) edges.delete();
    if (dilated) dilated.delete();
    if (contours) contours.delete();
    if (hierarchy) hierarchy.delete();
    if (poly) poly.delete();
  }
}

// Helper to order points: TL, TR, BR, BL
function orderPoints(pts) {
  // sort by x
  let xSorted = [...pts].sort((a, b) => a.x - b.x);
  
  // Leftmost points
  let leftMost = xSorted.slice(0, 2);
  // Rightmost points
  let rightMost = xSorted.slice(2, 4);

  // TL is the one with smaller y among leftMost, BL has larger y
  leftMost.sort((a, b) => a.y - b.y);
  let tl = leftMost[0];
  let bl = leftMost[1];

  // TR is the one with smaller y among rightMost, BR has larger y
  rightMost.sort((a, b) => a.y - b.y);
  let tr = rightMost[0];
  let br = rightMost[1];

  return [tl, tr, br, bl];
}
