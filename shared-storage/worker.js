/**
 * Phuong Chau CRM Dashboard — GitHub Shared Storage Gateway.
 * Cloudflare Worker source; NOT deployed by this repository.
 *
 * Required Worker secrets:
 *   GITHUB_TOKEN          fine-grained PAT, Contents read/write on crmproject only
 *   SESSION_SECRET        32+ bytes random secret used for short-lived HMAC login tokens
 * Required Worker vars:
 *   ACCESS_TEAM_DOMAIN    e.g. company.cloudflareaccess.com
 *   ACCESS_AUD            Cloudflare Access Application AUD tag for /auth/start
 *   ADMIN_EMAILS          comma-separated allowed admin emails
 *   ALLOWED_ORIGINS       e.g. https://winniequyen-coder.github.io,http://localhost:8000
 * Optional Worker vars:
 *   DATA_REPO             defaults to winniequyen-coder/crmproject
 *   DATA_BRANCH           defaults to preview/dashboard-data-v20-8
 *   DATA_FILE             defaults to data/project-data.json
 *
 * Setup: Protect /auth/start with a Cloudflare Access application.
 * Never publish secrets in HTML or GitHub.
 */
const enc = new TextEncoder();
const dec = new TextDecoder();
const githubHeaders = token => ({
  "Authorization": "Bearer " + token,
  "Accept": "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "PCG-CRM-Shared-Data-Gateway"
});
const b64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/,"");
const b64Decode = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length/4)*4, "=")), c => c.charCodeAt(0));
const fromUtf8B64 = b => dec.decode(b64Decode(b.replace(/\s/g,"")));
const toUtf8B64 = s => { const bytes=enc.encode(s);let out="";for(let i=0;i<bytes.length;i+=8192)out+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(out); };
const obj = (value,code=200,headers={}) => new Response(JSON.stringify(value),{status:code,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store",...headers}});
const textError = (error,status=500) => obj({error},status);
const allowedOrigins = env => (env.ALLOWED_ORIGINS||"").split(",").map(x=>x.trim()).filter(Boolean);
const cors = (origin,env) => allowedOrigins(env).includes(origin) ? {
 "Access-Control-Allow-Origin":origin,
 "Access-Control-Allow-Headers":"Content-Type, Authorization, If-Match",
 "Access-Control-Allow-Methods":"GET, PUT, OPTIONS",
 "Access-Control-Max-Age":"600",
 "Vary":"Origin"
} : {};
const cfg = env => ({
 repo: env.DATA_REPO || "winniequyen-coder/crmproject",
 branch: env.DATA_BRANCH || "preview/dashboard-data-v20-8",
 file: env.DATA_FILE || "data/project-data.json"
});
const urlFor = env => {const c=cfg(env);return "https://api.github.com/repos/"+c.repo+"/contents/"+c.file;};
async function githubGet(env) {
 const url=urlFor(env)+"?ref="+encodeURIComponent(cfg(env).branch);
 const res=await fetch(url,{headers:githubHeaders(env.GITHUB_TOKEN),cf:{cacheTtl:0}});
 if(!res.ok)throw Object.assign(new Error("GitHub read failed ("+res.status+")"),{code:502});
 const file=await res.json();
 if(file.type!=="file"||!file.sha||typeof file.content!=="string")throw new Error("Invalid GitHub file response");
 const parsed=JSON.parse(fromUtf8B64(file.content));
 if(parsed.schema!==21||!parsed.data||!Array.isArray(parsed.data.mainTasks)||!Array.isArray(parsed.data.hubTasks))throw new Error("Invalid shared-data schema");
 return {sha:file.sha,payload:parsed};
}
async function verifyCloudflareJWT(jwt,env) {
 if(!jwt)throw new Error("Missing Cloudflare Access identity");
 const chunks=jwt.split("."); if(chunks.length!==3)throw new Error("Malformed JWT");
 let header,payload;try{
   header=JSON.parse(dec.decode(b64Decode(chunks[0])));
   payload=JSON.parse(dec.decode(b64Decode(chunks[1])));
 }catch{throw new Error("Invalid JWT encoding")}
 if(header.alg!=="RS256"||typeof header.kid!=="string")throw new Error("Unsupported JWT algorithm");
 const team=String(env.ACCESS_TEAM_DOMAIN||"").replace(/^https?:\/\//,"").replace(/\/+$/,"");
 if(!team||!env.ACCESS_AUD)throw new Error("Cloudflare Access is not configured");
 const issuer="https://"+team;
 if(payload.iss!==issuer||!(Array.isArray(payload.aud)?payload.aud.includes(env.ACCESS_AUD):payload.aud===env.ACCESS_AUD)||payload.exp<=Math.floor(Date.now()/1000))throw new Error("Invalid Access audience, issuer or expiry");
 const certRes=await fetch(issuer+"/cdn-cgi/access/certs",{cf:{cacheTtl:300}});
 if(!certRes.ok)throw new Error("Cloudflare Access certificates unavailable");
 const jwks=await certRes.json(),keyEntry=(jwks.keys||[]).find(k=>k.kid===header.kid);
 if(!keyEntry)throw new Error("No matching Cloudflare Access signing key");
 const key=await crypto.subtle.importKey("jwk",keyEntry,{name:"RSASSA-PKCS1-v1_5",hash:"SHA-256"},false,["verify"]);
 const verified=await crypto.subtle.verify("RSASSA-PKCS1-v1_5",key,b64Decode(chunks[2]),enc.encode(chunks[0]+"."+chunks[1]));
 if(!verified)throw new Error("Invalid Cloudflare Access signature");
 const email=String(payload.email||"").toLowerCase();
 if(!(env.ADMIN_EMAILS||"").split(",").map(x=>x.trim().toLowerCase()).includes(email))throw new Error("Email is not an authorized Dashboard Admin");
 return email;
}
async function hmacKey(env) {
 if(!env.SESSION_SECRET||env.SESSION_SECRET.length<32)throw new Error("SESSION_SECRET must have 32+ characters");
 return crypto.subtle.importKey("raw",enc.encode(env.SESSION_SECRET),{name:"HMAC",hash:"SHA-256"},false,["sign","verify"]);
}
async function signSession(email,origin,env){
 const head=b64url(enc.encode(JSON.stringify({alg:"HS256",typ:"JWT"})));
 const body=b64url(enc.encode(JSON.stringify({sub:email,aud:"pcg-dashboard-write",origin,exp:Math.floor(Date.now()/1000)+3600})));
 const data=head+"."+body,signature=await crypto.subtle.sign("HMAC",await hmacKey(env),enc.encode(data));
 return data+"."+b64url(new Uint8Array(signature));
}
async function verifySession(token,origin,env) {
 if(!token||token.split(".").length!==3)throw new Error("Admin authentication required");
 const [head,body,signature]=token.split(".");
 let data;try{data=JSON.parse(dec.decode(b64Decode(body)))}catch{throw new Error("Invalid admin token")}
 const valid=await crypto.subtle.verify("HMAC",await hmacKey(env),b64Decode(signature),enc.encode(head+"."+body));
 if(!valid||data.aud!=="pcg-dashboard-write"||data.exp<=Math.floor(Date.now()/1000)||data.origin!==origin)throw new Error("Admin session expired or invalid");
 return String(data.sub||"");
}
export default {
 async fetch(req,env) {
  const u=new URL(req.url),origin=req.headers.get("Origin")||"";
  const headers=cors(origin,env);
  const respond=(value,code=200)=>obj(value,code,headers);
  if(req.method==="OPTIONS")return new Response(null,{status:204,headers});
  if(req.method==="GET"&&u.pathname==="/health")return respond({status:"ok",service:"PCG GitHub shared data gateway"});
  if(!env.GITHUB_TOKEN)return respond({error:"Gateway not configured: GITHUB_TOKEN missing"},503);
  if(req.method==="GET"&&u.pathname==="/state") {
   try{const {sha,payload}=await githubGet(env);return respond({sha,...payload})}
   catch(e){return respond({error:String(e.message)},e.code||502)}
  }
  if(req.method==="GET"&&u.pathname==="/auth/start") {
   const returnOrigin=u.searchParams.get("origin")||"";
   if(!allowedOrigins(env).includes(returnOrigin))return textError("Origin not allowed",403);
   let email;try{email=await verifyCloudflareJWT(req.headers.get("Cf-Access-Jwt-Assertion"),env)}catch(e){return textError(e.message,401)}
   const token=await signSession(email,returnOrigin,env);
   const target=JSON.stringify(returnOrigin),payload=JSON.stringify({type:"PCG_GITHUB_SHARED_AUTH",token,email});
   const html='<!doctype html><html lang="vi"><meta charset="utf-8"><title>CRM Admin</title><body><p>Đã xác thực Admin. Cửa sổ này sẽ tự đóng.</p><script>if(window.opener){window.opener.postMessage('+payload+','+target+');window.close()}<\/script></body></html>';
   return new Response(html,{headers:{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store","Content-Security-Policy":"default-src 'none'; script-src 'unsafe-inline'; style-src 'none'; base-uri 'none'; form-action 'none'"}});
  }
  if(req.method==="PUT"&&u.pathname==="/state") {
   if(!allowedOrigins(env).includes(origin))return respond({error:"Origin not allowed"},403);
   let email;try{email=await verifySession((req.headers.get("Authorization")||"").replace(/^Bearer\s+/i,""),origin,env)}catch(e){return respond({error:e.message},401)}
   const expected=(req.headers.get("If-Match")||"").replace(/^"|"$/g,"").trim();
   if(!/^[a-f0-9]{40}$/i.test(expected))return respond({error:"Expected GitHub SHA required in If-Match"},428);
   let payload;try{const raw=await req.text();if(raw.length>3_000_000)throw new Error("Payload too large");payload=JSON.parse(raw)}catch(e){return respond({error:"Invalid JSON: "+e.message},400)}
   if(payload.schema!==21||!payload.data||!Array.isArray(payload.data.mainTasks)||!Array.isArray(payload.data.hubTasks))return respond({error:"Invalid data schema"},400);
   if(cfg(env).branch==="main")return respond({error:"Writing shared data to main is forbidden"},403);
   for(const [name,arr] of [["mainTasks",payload.data.mainTasks],["hubTasks",payload.data.hubTasks]]) {
     const ids=new Set();
     for(const t of arr) {
       if(!t||typeof t.TaskID!=="string"||!t.TaskID.trim()||ids.has(t.TaskID))return respond({error:"Missing or duplicate Task ID in "+name},400);
       ids.add(t.TaskID);
       if(typeof t.Task!=="string")return respond({error:"Invalid task name in "+name},400);
       if(t.ReportedPct!==undefined&&(typeof t.ReportedPct!=="number"||t.ReportedPct<0||t.ReportedPct>1))return respond({error:"Invalid task progress in "+name},400);
     }
     if(arr.some(t=>t.ParentID&&!ids.has(t.ParentID)))return respond({error:"Broken Parent ID hierarchy in "+name},400);
   }
   if(payload.data.mainTasks.length>10000||payload.data.hubTasks.length>10000)return respond({error:"Task count exceeds safety limit"},400);
   let current;try{current=await githubGet(env)}catch(e){return respond({error:e.message},502)}
   if(current.sha!==expected)return respond({error:"CONFLICT",message:"Another user updated the shared file. Reload before saving.",currentSha:current.sha},409);
   const savedAt=new Date().toISOString(),saved={schema:21,savedAt,data:payload.data};
   const body={message:"Dashboard task update by "+email+" at "+savedAt,content:toUtf8B64(JSON.stringify(saved)),sha:expected,branch:cfg(env).branch};
   const put=await fetch(urlFor(env),{method:"PUT",headers:{...githubHeaders(env.GITHUB_TOKEN),"Content-Type":"application/json"},body:JSON.stringify(body)});
   const result=await put.json().catch(()=>({}));
   if(put.status===409||put.status===422)return respond({error:"CONFLICT",message:"GitHub rejected a stale revision. Reload to reconcile."},409);
   if(!put.ok||!result.content?.sha)return respond({error:"GitHub write failed ("+put.status+")"},502);
   return respond({ok:true,sha:result.content.sha,savedAt,savedBy:email});
  }
  return respond({error:"Not found"},404);
 }
};
