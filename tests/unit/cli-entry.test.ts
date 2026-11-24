import {mkdtempSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {expect,it} from 'vitest';
it('prints help when the installed entry is a symlink',()=>{
 const dir=mkdtempSync(join(tmpdir(),'agentleak-entry-'));
 try{const bin=join(dir,'agentleak');symlinkSync(resolve('dist/cli.js'),bin);const r=spawnSync(process.execPath,[bin,'--help'],{encoding:'utf8'});expect(r.status).toBe(0);expect(r.stdout).toContain('Usage');}finally{rmSync(dir,{recursive:true,force:true});}
});
