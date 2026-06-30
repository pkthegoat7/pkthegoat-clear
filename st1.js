const {createHmac}=require("crypto");const WebSocket=require("ws");
const SEG="8E/S7WtI5WSP8/Gf7lQg+8kqIeBhXlvxOz42ve+HdNQ=";
function emitir(o,seg,ttl){const p={email:o.email,nome:o.nome,exp:Date.now()+ttl};const b=Buffer.from(JSON.stringify(p)).toString("base64url");const s=createHmac("sha256",seg).update(b).digest("base64url");return b+"."+s;}
const t=emitir({email:"patricknicoli55@gmail.com",nome:"pkthegoat att"},SEG,90000);
const ws=new WebSocket("wss://self-browser-production.up.railway.app/stream?ticket="+encodeURIComponent(t));
ws.binaryType="arraybuffer";let frames=0,aBytes=0,aT0=null;
ws.on("message",d=>{ if(typeof d==="string"){try{if(JSON.parse(d).t==="frame")frames++;}catch(e){}} else { if(!aT0)aT0=Date.now(); aBytes+=d.byteLength; } });
ws.on("close",(c,r)=>console.log("CLOSE",c,r&&r.toString()));
ws.on("error",e=>console.log("ERR",e.message));
setTimeout(()=>{const ad=aT0?(Date.now()-aT0)/1000:0;console.log("VIDEO frames:",frames,"| AUDIO B/s:",ad?Math.round(aBytes/ad):0,"(alvo ~96000)");try{ws.close();}catch(e){}process.exit(0);},12000);
