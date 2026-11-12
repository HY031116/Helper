/* Real Electron smoke and reproducible measurements, always with an isolated profile. */
'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const started = Date.now();
const output = process.env.LIGHTWEIGHT_QA_OUTPUT || fs.mkdtempSync(path.join(os.tmpdir(),'work-helper-lightweight-'));
fs.mkdirSync(output,{recursive:true});
process.argv.push(`--work-helper-data-dir=${path.join(output,'profile')}`);
const root = process.env.LIGHTWEIGHT_QA_ROOT || path.resolve(__dirname,'..');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
require(path.join(root,'src/main'));
const pause = ms => new Promise(resolve => setTimeout(resolve,ms));
app.whenReady().then(async () => {
  try {
    let win;
    for(let n=0;n<100;n++) {
      win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/index.html'));
      if(win && !win.webContents.isLoading()) break;
      await pause(100);
    }
    if(!win) throw new Error('Main window missing');
    await pause(500);
    const startupMs = Date.now()-started;
    await pause(2000);
    const idleMetrics = app.getAppMetrics();
    win.show();
    const errors=[];
    win.webContents.on('console-message', (_e,level,message) => { if(level===3) errors.push(message); });
    if(!process.env.LIGHTWEIGHT_QA_BASELINE) {
      await win.webContents.executeJavaScript(`(async () => {
        const task = await window.api.tasks.create({title:'Electron worklog smoke'});
        await window.api.tasks.update(task.id,{status:'doing'});
        await window.api.tasks.complete(task.id);
        const today = new Date().toLocaleDateString('en-CA');
        const note = await window.api.worklog.addNote(today,'Electron note smoke');
        switchView('records'); await renderRecords();
        if(!document.querySelector('.record-metrics') || !document.querySelector('[data-note-id]')) throw new Error('Record UI missing');
        await window.api.worklog.removeNote(today,note.id);
      })()`);
      for(const dark of [false,true]) for(const width of [1100,650]) {
        win.setSize(width,800);
        await win.webContents.executeJavaScript(`document.body.classList.toggle('dark',${dark});`);
        for(const view of ['today','list','records','settings']) {
          await win.webContents.executeJavaScript(`switchView('${view}');`); await pause(500);
          fs.writeFileSync(path.join(output,`${dark?'dark':'light'}-${width}-${view}.png`),(await win.webContents.capturePage()).toPNG());
        }
      }
      await win.webContents.debugger.attach('1.3');
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
      const reduced = await win.webContents.executeJavaScript(`matchMedia('(prefers-reduced-motion: reduce)').matches`);
      if(!reduced) throw new Error('Reduced motion emulation failed');
    }
    await pause(2000);
    const result={startupMs, windowCount:BrowserWindow.getAllWindows().length, metrics:idleMetrics, errors, output};
    fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(result,null,2));
    app.exit(errors.length?1:0);
  } catch(error) { fs.writeFileSync(path.join(output,'error.txt'),error.stack); app.exit(1); }
});
setTimeout(()=>app.exit(2),45000);
