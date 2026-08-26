'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const root = path.resolve(__dirname, '..');
const assetDir = path.join(root, 'src', 'assets');
const sourcePath = path.join(assetDir, 'app-icon.svg');
const icoPath = path.join(assetDir, 'app-icon.ico');
const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256, 512];

function iconBuffer(entries) {
  const headerSize = 6 + entries.length * 16;
  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  let offset = headerSize;
  entries.forEach(({ size, png }, index) => {
    const entryOffset = 6 + index * 16;
    header.writeUInt8(size >= 256 ? 0 : size, entryOffset);
    header.writeUInt8(size >= 256 ? 0 : size, entryOffset + 1);
    header.writeUInt8(0, entryOffset + 2);
    header.writeUInt8(0, entryOffset + 3);
    header.writeUInt16LE(1, entryOffset + 4);
    header.writeUInt16LE(32, entryOffset + 6);
    header.writeUInt32LE(png.length, entryOffset + 8);
    header.writeUInt32LE(offset, entryOffset + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...entries.map((entry) => entry.png)]);
}

app.whenReady().then(async () => {
  const svg = fs.readFileSync(sourcePath, 'utf8');
  const dataUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  const renderer = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: false, nodeIntegration: false, sandbox: true }
  });
  await renderer.loadURL('data:text/html;charset=utf-8,<html><body></body></html>');
  const encodedPngs = await renderer.webContents.executeJavaScript(`
    (async () => {
      const image = new Image();
      image.src = ${JSON.stringify(dataUrl)};
      await image.decode();
      return ${JSON.stringify(sizes)}.map((size) => {
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const context = canvas.getContext('2d');
        context.clearRect(0, 0, size, size);
        context.drawImage(image, 0, 0, size, size);
        return canvas.toDataURL('image/png').split(',')[1];
      });
    })()
  `);
  renderer.destroy();

  const entries = sizes.map((size, index) => {
    const png = Buffer.from(encodedPngs[index], 'base64');
    fs.writeFileSync(path.join(assetDir, `app-icon-${size}.png`), png);
    return { size, png };
  });
  fs.writeFileSync(icoPath, iconBuffer(entries.filter((entry) => entry.size <= 256)));
  process.stdout.write(`ICON_SOURCE=${sourcePath}\nICON_ICO=${icoPath}\nICON_SIZES=${sizes.join(',')}\n`);
  app.quit();
}).catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  app.exit(1);
});
