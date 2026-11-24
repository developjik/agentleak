import {mkdtempSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {expect,it} from 'vitest';
it.each([{flags:[]},{flags:['--preserve-symlinks-main']}])('prints help through the installed symlink with flags %j',({flags})=>{
 const dir=mkdtempSync(join(tmpdir(),'agentleak-entry-'));
 try{const bin=flags.length?resolve('dist',`.cli-test-${process.pid}.js`):join(dir,'agentleak');symlinkSync(resolve('dist/cli.js'),bin);const r=spawnSync(process.execPath,[...flags,bin,'--help'],{encoding:'utf8'});expect(r.status).toBe(0);expect(r.stdout).toContain('Usage');if(flags.length)rmSync(bin);}finally{rmSync(dir,{recursive:true,force:true});}
});
