import {test,expect} from 'vitest';
test('failed raw comparisons never claim complete similarity',async()=>{
 const {compareUserAgents}=await import('../../src/cloaking.js');const {makeObservation}=await import('./factory.js');
 const baseline=makeObservation({rawTextError:'failed',rawTextBlocks:[]});const other=makeObservation({uaId:'gptbot',rawTextError:'failed',rawTextBlocks:[]});
 expect(compareUserAgents(baseline,[other]).pairs[0]).toMatchObject({rawComparable:false,similarity:0,verdict:'error',botOnly:[]});
});

test('both markdown comparison tables mark unmeasured similarity unavailable',async()=>{
 const {renderMarkdown}=await import('../../src/report/markdown.js');const {makeSnapshot,makeObservation}=await import('./factory.js');const {compareUserAgents}=await import('../../src/cloaking.js');
 const baseline=makeObservation({rawTextError:'failed',rawTextBlocks:[]});const bot=makeObservation({uaId:'gptbot',label:'GPTBot',rawTextError:'failed',rawTextBlocks:[]});const snapshot=makeSnapshot([]);snapshot.observations=[baseline,bot];snapshot.cloaking=compareUserAgents(baseline,[bot]);
 const markdown=renderMarkdown(snapshot);expect(markdown.match(/unavailable/g)).toHaveLength(2);expect(markdown).not.toContain('| 0% |');
});
