const fs = require('fs');
const { PNG } = require('pngjs');

const MAIN_SIZE = 1024;
const FAVICON_SIZE = 64;

const BRAND_BG = { r: 255, g: 107, b: 53, a: 255 }; // 橙色背景
const BRAND_BLACK = { r: 10, g: 10, b: 10, a: 255 }; // 黑色图标

function fillBackground(png, color) {
  const { width, height } = png;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = (width * y + x) << 2;
      png.data[idx] = color.r;
      png.data[idx + 1] = color.g;
      png.data[idx + 2] = color.b;
      png.data[idx + 3] = color.a;
    }
  }
}

function drawRoundedRect(png, x, y, width, height, radius, color) {
  const minX = Math.max(0, Math.floor(x));
  const maxX = Math.min(png.width - 1, Math.ceil(x + width));
  const minY = Math.max(0, Math.floor(y));
  const maxY = Math.min(png.height - 1, Math.ceil(y + height));

  for (let py = minY; py <= maxY; py += 1) {
    for (let px = minX; px <= maxX; px += 1) {
      const left = x + radius;
      const right = x + width - radius;
      const top = y + radius;
      const bottom = y + height - radius;

      let inside = false;
      if (px >= left && px <= right) inside = true;
      if (py >= top && py <= bottom) inside = true;

      if (!inside) {
        const corners = [
          { cx: left, cy: top },
          { cx: right, cy: top },
          { cx: left, cy: bottom },
          { cx: right, cy: bottom },
        ];
        for (const corner of corners) {
          const dx = px - corner.cx;
          const dy = py - corner.cy;
          if ((dx * dx) + (dy * dy) <= radius * radius) {
            inside = true;
            break;
          }
        }
      }

      if (!inside) continue;

      const idx = (png.width * py + px) << 2;
      png.data[idx] = color.r;
      png.data[idx + 1] = color.g;
      png.data[idx + 2] = color.b;
      png.data[idx + 3] = color.a;
    }
  }
}

function drawRing(png, centerX, centerY, radius, width, color) {
  const inner = radius - width;
  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      const dx = x - centerX;
      const dy = y - centerY;
      const dist = Math.sqrt((dx * dx) + (dy * dy));
      if (dist < inner || dist > radius) continue;
      const idx = (png.width * y + x) << 2;
      png.data[idx] = color.r;
      png.data[idx + 1] = color.g;
      png.data[idx + 2] = color.b;
      png.data[idx + 3] = color.a;
    }
  }
}

function createRobotIcon(size) {
  const png = new PNG({ width: size, height: size });
  fillBackground(png, BRAND_BG);

  const centerX = size / 2;
  const centerY = size / 2;

  const outerRadius = (size / 2) - Math.round(size * 0.06);
  const ringWidth = Math.round(size * 0.04);
  drawRing(png, centerX, centerY, outerRadius, ringWidth, BRAND_BLACK);

  const eyeSize = Math.round(size * 0.14);
  const eyeGap = Math.round(size * 0.14);
  const eyeRadius = Math.round(size * 0.02);
  const eyeY = centerY - Math.round(size * 0.06);

  drawRoundedRect(
    png,
    centerX - (eyeGap / 2) - (eyeSize / 2),
    eyeY - (eyeSize / 2),
    eyeSize,
    eyeSize,
    eyeRadius,
    BRAND_BLACK,
  );
  drawRoundedRect(
    png,
    centerX + (eyeGap / 2) - (eyeSize / 2),
    eyeY - (eyeSize / 2),
    eyeSize,
    eyeSize,
    eyeRadius,
    BRAND_BLACK,
  );

  const mouthWidth = Math.round(size * 0.27);
  const mouthHeight = Math.round(size * 0.055);
  const mouthY = centerY + Math.round(size * 0.17);
  drawRoundedRect(
    png,
    centerX - (mouthWidth / 2),
    mouthY - (mouthHeight / 2),
    mouthWidth,
    mouthHeight,
    Math.round(size * 0.012),
    BRAND_BLACK,
  );

  return png;
}

function resizeNearest(src, nextSize) {
  const out = new PNG({ width: nextSize, height: nextSize });
  for (let y = 0; y < nextSize; y += 1) {
    for (let x = 0; x < nextSize; x += 1) {
      const srcX = Math.floor((x * src.width) / nextSize);
      const srcY = Math.floor((y * src.height) / nextSize);
      const srcIdx = (src.width * srcY + srcX) << 2;
      const outIdx = (nextSize * y + x) << 2;
      out.data[outIdx] = src.data[srcIdx];
      out.data[outIdx + 1] = src.data[srcIdx + 1];
      out.data[outIdx + 2] = src.data[srcIdx + 2];
      out.data[outIdx + 3] = src.data[srcIdx + 3];
    }
  }
  return out;
}

function writePng(path, png) {
  const buffer = PNG.sync.write(png);
  fs.writeFileSync(path, buffer);
}

const main = createRobotIcon(MAIN_SIZE);
const favicon = resizeNearest(main, FAVICON_SIZE);

writePng('assets/icon.png', main);
writePng('assets/adaptive-icon.png', main);
writePng('assets/splash-icon.png', main);
writePng('assets/favicon.png', favicon);

console.log('Robot brand assets generated:');
console.log('- assets/icon.png');
console.log('- assets/adaptive-icon.png');
console.log('- assets/splash-icon.png');
console.log('- assets/favicon.png');
