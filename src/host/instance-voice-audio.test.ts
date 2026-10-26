import {test} from 'node:test';
import assert from 'node:assert/strict';
import {wavPcm24k} from './instance-voice-audio.js';
const header=()=>Buffer.from('52494646ffffffff57415645666d74201000000001000100c05d000080bb00000200100064617461ffffffff','hex');
const stream=(chunks:Buffer[])=>new ReadableStream<Uint8Array>({start(controller){for(const chunk of chunks)controller.enqueue(chunk);controller.close();}});
async function collect(chunks:Buffer[]){const result=[];for await(const value of wavPcm24k(stream(chunks))){assert.equal(value.length%2,0);result.push(value);}return Buffer.concat(result);}
test('streaming WAV headers split across HTTP packets preserve every complete PCM sample',async()=>{
 const pcm=Buffer.from([1,2,3,4,5,6]),wav=Buffer.concat([header(),pcm]);
 assert.deepEqual(await collect([wav.subarray(0,5),wav.subarray(5,39),wav.subarray(39,45),wav.subarray(45,49),wav.subarray(49)]),pcm);
});
test('speech rejects the wrong sample rate and truncated samples',async()=>{
 const invalid=header();invalid.writeUInt32LE(48000,24);
 await assert.rejects(collect([invalid,Buffer.alloc(2)]),/24 kHz/);
 await assert.rejects(collect([header(),Buffer.alloc(1)]),/Incomplete/);
 await assert.rejects(collect([Buffer.from('not a WAV stream')]),/Invalid/);
});
