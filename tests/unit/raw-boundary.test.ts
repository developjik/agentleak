import {test,expect} from 'vitest';
test('failed raw comparisons never claim complete similarity',async()=>{
 const {compareUserAgents}=await import('../../src/cloaking.js');const {makeObservation}=await import('./factory.js');
 const baseline=makeObservation({rawTextError:'failed',rawTextBlocks:[]});const other=makeObservation({uaId:'gptbot',rawTextError:'failed',rawTextBlocks:[]});
 expect(compareUserAgents(baseline,[other]).pairs[0]).toMatchObject({rawComparable:false,similarity:0,verdict:'error',botOnly:[]});
});
