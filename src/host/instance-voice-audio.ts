/** Strip a bounded streaming WAV header without buffering generated speech.
 * oMLX uses unknown RIFF/data sizes while emitting PCM16 mono at 24 kHz. */
export async function* wavPcm24k(stream:ReadableStream<Uint8Array>):AsyncGenerator<Buffer> {
  const reader=stream.getReader();let header=Buffer.alloc(0),position=12,format=false,started=false,carry=Buffer.alloc(0),total=0;
  try {
    for(;;){
      const {done,value}=await reader.read();if(done)break;
      let audio:Buffer=Buffer.from(value);
      if(!started){
        header=Buffer.concat([header,audio]);audio=Buffer.alloc(0);
        if(header.length<12)continue;
        if(header.toString('ascii',0,4)!=='RIFF'||header.toString('ascii',8,12)!=='WAVE')throw Error('Invalid speech WAV');
        while(header.length>=position+8){
          const name=header.toString('ascii',position,position+4),size=header.readUInt32LE(position+4);
          if(name==='data'){
            if(!format)throw Error('Speech PCM format missing');started=true;audio=header.subarray(position+8);header=Buffer.alloc(0);break;
          }
          if(size>65536)throw Error('Speech header exceeds its limit');
          if(header.length<position+8+size)break;
          if(name==='fmt '){
            const at=position+8;
            if(size<16||header.readUInt16LE(at)!==1||header.readUInt16LE(at+2)!==1||header.readUInt32LE(at+4)!==24000||header.readUInt16LE(at+12)!==2||header.readUInt16LE(at+14)!==16)throw Error('Speech requires PCM16 mono at 24 kHz');
            format=true;
          }
          position+=8+size+(size%2);
        }
        if(!started){if(header.length>65536)throw Error('Speech header exceeds its limit');continue;}
      }
      if(carry.length)audio=Buffer.concat([carry,audio]);
      const even=audio.length-audio.length%2;carry=Buffer.from(audio.subarray(even));
      if(even){total+=even;if(total>12*1024*1024)throw Error('Speech exceeds its limit');yield audio.subarray(0,even);}
    }
    if(!started||!total||carry.length)throw Error('Incomplete speech audio');
  }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
