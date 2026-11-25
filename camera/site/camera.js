const view = document.querySelector('#view');
const ctx = view.getContext('2d', { willReadFrequently: true });
const histogram = document.querySelector('#histogram');
const hist = histogram.getContext('2d');
const exposure = document.querySelector('#exposure');
const file = document.querySelector('#file');
const error = document.querySelector('#image-error');

function testPattern() {
  view.width = 640;
  view.height = 400;
  const gradient = ctx.createLinearGradient(0, 0, 640, 400);
  gradient.addColorStop(0, '#111');
  gradient.addColorStop(1, '#d6d6d6');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 640, 400);
  for (let i = 0; i < 8; i++) {
    const luma = 20 + i * 31;
    ctx.fillStyle = 'rgb(' + [luma, luma, luma].join(',') + ')';
    ctx.fillRect(24 + i * 74, 36, 74, 92);
  }
  const light = ctx.createRadialGradient(240, 203, 10, 285, 240, 103);
  light.addColorStop(0, '#fafafa');
  light.addColorStop(1, '#242424');
  ctx.beginPath();
  ctx.arc(270, 229, 93, 0, Math.PI * 2);
  ctx.fillStyle = light;
  ctx.fill();
  for (const [index, step] of [18, 11, 6, 3, 2].entries()) {
    const x = 388 + index * 36;
    ctx.fillStyle = '#383838';
    ctx.fillRect(x, 167, 32, 123);
    ctx.fillStyle = '#bcbcbc';
    for (let y = 168; y < 289; y += step * 2) ctx.fillRect(x, y, 32, Math.min(step, 289 - y));
  }
  const ramp = ctx.createLinearGradient(24, 0, 616, 0);
  ramp.addColorStop(0, '#000');
  ramp.addColorStop(1, '#fff');
  ctx.fillStyle = ramp;
  ctx.fillRect(24, 328, 592, 46);
}

let source;
let loadId = 0;
function capture(label) {
  source = ctx.getImageData(0, 0, view.width, view.height);
  document.querySelector('#image-source').textContent = label;
  document.querySelector('#resolution').textContent = view.width + ' × ' + view.height;
  exposure.value = '0';
  draw();
}

function draw() {
  const ev = Number(exposure.value);
  const gain = 2 ** ev;
  const pixels = source.data;
  const preview = ctx.createImageData(source.width, source.height);
  const bins = new Uint32Array(64);
  let saturated = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    const value = Math.min(255, Math.round((.2126 * pixels[i] + .7152 * pixels[i+1] + .0722 * pixels[i+2]) * gain));
    preview.data[i] = preview.data[i+1] = preview.data[i+2] = value;
    preview.data[i+3] = 255;
    bins[value >> 2]++;
    if (value === 255) saturated++;
  }
  ctx.putImageData(preview, 0, 0);
  const max = Math.log1p(Math.max(...bins));
  const width = histogram.width / bins.length;
  hist.clearRect(0, 0, histogram.width, histogram.height);
  bins.forEach((count, index) => {
    const height = Math.log1p(count) * histogram.height / max;
    hist.fillStyle = index === bins.length - 1 ? '#ffb078' : '#8ee3ce';
    hist.fillRect(index * width, histogram.height - height, width - 1, height);
  });
  document.querySelector('#ev').value = ev.toFixed(1) + ' EV';
  document.querySelector('#clipped').textContent = '饱和 ' + (400 * saturated / pixels.length).toFixed(1) + '%';
}

function reset() {
  loadId++;
  file.value = '';
  error.textContent = '';
  testPattern();
  capture('合成测试图');
}

exposure.addEventListener('input', draw);
document.querySelector('#reset').addEventListener('click', reset);
file.addEventListener('change', async () => {
  const selected = file.files[0];
  if (!selected) return;
  const id = ++loadId;
  error.textContent = '';
  try {
    const image = await createImageBitmap(selected);
    try {
      if (id !== loadId) return;
      const scale = Math.min(1, 1280 / Math.max(image.width, image.height));
      view.width = Math.max(1, Math.round(image.width * scale));
      view.height = Math.max(1, Math.round(image.height * scale));
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, view.width, view.height);
      ctx.drawImage(image, 0, 0, view.width, view.height);
      capture(selected.name);
    } finally {
      image.close();
    }
  } catch {
    if (id === loadId) error.textContent = '无法读取图像，请选择浏览器支持的 PNG、JPEG 或 WebP。';
  }
});
reset();
