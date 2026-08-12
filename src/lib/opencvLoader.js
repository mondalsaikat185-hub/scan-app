let cvReadyPromise = null;

export function loadOpenCV() {
  if (cvReadyPromise) return cvReadyPromise;

  cvReadyPromise = new Promise((resolve, reject) => {
    // Already ready?
    if (window.cv && window.cv.Mat) {
      resolve(window.cv);
      return;
    }

    let settled = false;
    const finishOk = () => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimeout);
      resolve(window.cv);
    };
    const finishErr = (msg) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimeout);
      reject(new Error(msg));
    };

    // Global timeout (60s) injected immediately
    const hardTimeout = setTimeout(() => {
      finishErr('OpenCV load timed out (network too slow or file blocked).');
    }, 60000);

    // Call this when OpenCV is ready
    window.Module = window.Module || {};
    const prevInit = window.Module.onRuntimeInitialized;
    window.Module.onRuntimeInitialized = () => {
      if (typeof prevInit === 'function') prevInit();
      finishOk();
    };

    // Backup polling
    const poll = setInterval(() => {
      if (window.cv && window.cv.Mat) {
        clearInterval(poll);
        finishOk();
      } else if (settled) {
        clearInterval(poll);
      }
    }, 200);

    const script = document.createElement('script');
    script.src = '/opencv.js';
    script.async = true;
    script.onerror = () => {
      clearInterval(poll);
      finishErr('Failed to download OpenCV.js');
    };
    document.body.appendChild(script);
  });

  return cvReadyPromise;
}
