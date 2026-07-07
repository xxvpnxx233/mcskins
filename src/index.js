import { unzipSync, zipSync, strToU8, strFromU8 } from "fflate";
import forge from "node-forge";

const HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>MC APK 自动改包工具</title>
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Arial,sans-serif;background:#0f172a;color:#e5e7eb;margin:0;padding:32px}
    .card{max-width:760px;margin:auto;background:#111827;border:1px solid #334155;border-radius:18px;padding:26px;box-shadow:0 20px 50px #0007}
    h1{margin-top:0;color:#86efac}.row{margin:18px 0}label{display:block;margin-bottom:8px;color:#cbd5e1}
    input[type=file]{width:100%;padding:12px;border:1px dashed #64748b;border-radius:12px;background:#0b1220;color:#e5e7eb}
    button{background:#22c55e;color:#052e16;border:0;border-radius:12px;padding:13px 20px;font-weight:800;cursor:pointer}
    button:disabled{opacity:.55;cursor:not-allowed}.log{white-space:pre-wrap;background:#020617;border-radius:12px;padding:14px;margin-top:16px;color:#a7f3d0;min-height:54px}
    .hint{color:#94a3b8;font-size:14px;line-height:1.7}.err{color:#fecaca}.ok{color:#bbf7d0}
  </style>
</head>
<body>
  <div class="card">
    <h1>MC APK 自动改包工具</h1>
    <p class="hint">上传 APK、custom 皮肤包、persona 皮肤包。程序会把两个皮肤包分别导入 APK 内第一个匹配到的 <code>*/skin_packs/custom/</code> 和 <code>*/skin_packs/persona/</code>，然后重新打包并签名。</p>
    <form id="f">
      <div class="row"><label>APK 文件</label><input name="apk" type="file" accept=".apk,application/vnd.android.package-archive" required></div>
      <div class="row"><label>custom 皮肤包（.mcpack/.zip）</label><input name="custom_pack" type="file" accept=".mcpack,.zip" required></div>
      <div class="row"><label>persona 皮肤包（.mcpack/.zip）</label><input name="persona_pack" type="file" accept=".mcpack,.zip" required></div>
      <button id="btn">开始打包</button>
    </form>
    <div id="log" class="log">等待上传...</div>
  </div>
<script>
const form=document.getElementById('f');const log=document.getElementById('log');const btn=document.getElementById('btn');
form.onsubmit=async e=>{e.preventDefault();btn.disabled=true;log.textContent='上传并处理 APK 中...';
 try{const res=await fetch('/api/build',{method:'POST',body:new FormData(form)});if(!res.ok){throw new Error(await res.text())}
 const blob=await res.blob();const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='minecraft_skin_signed.apk';a.click();URL.revokeObjectURL(url);log.innerHTML='<span class="ok">完成，已开始下载。</span>';
 }catch(err){log.innerHTML='<span class="err">失败：'+String(err.message||err).replace(/[<>&]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]))+'</span>'}
 finally{btn.disabled=false}
};
</script>
</body></html>`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") {
      return new Response(HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (request.method === "POST" && url.pathname === "/api/build") {
      return buildApk(request, env);
    }
    return new Response("Not Found", { status: 404 });
  }
};

async function buildApk(request, env) {
  if (!env.SIGN_KEY_PEM || !env.SIGN_CERT_PEM) {
    return new Response("缺少 Cloudflare Secret：SIGN_KEY_PEM 或 SIGN_CERT_PEM", { status: 500 });
  }

  const form = await request.formData();
  const apk = form.get("apk");
  const custom = form.get("custom_pack");
  const persona = form.get("persona_pack");
  if (!isFile(apk) || !isFile(custom) || !isFile(persona)) {
    return new Response("需要上传 apk、custom_pack、persona_pack 三个文件", { status: 400 });
  }

  const apkBytes = new Uint8Array(await apk.arrayBuffer());
  const customBytes = new Uint8Array(await custom.arrayBuffer());
  const personaBytes = new Uint8Array(await persona.arrayBuffer());

  let apkZip;
  try { apkZip = unzipSync(apkBytes); } catch { return new Response("APK 不是有效 ZIP/APK 文件", { status: 400 }); }

  stripOldSignatures(apkZip);
  const skinRoot = findSkinPacksDir(apkZip);
  if (!skinRoot) return new Response("APK 内没有找到 */skin_packs/ 目录", { status: 400 });

  injectPack(apkZip, `${skinRoot}custom/`, customBytes);
  injectPack(apkZip, `${skinRoot}persona/`, personaBytes);

  const signedZip = await addJarV1Signature(apkZip, env.SIGN_KEY_PEM, env.SIGN_CERT_PEM);
  const out = zipSync(signedZip, { level: 6 });

  return new Response(out, {
    headers: {
      "content-type": "application/vnd.android.package-archive",
      "content-disposition": 'attachment; filename="minecraft_skin_signed.apk"',
      "cache-control": "no-store"
    }
  });
}

function isFile(v) { return v && typeof v.arrayBuffer === "function" && typeof v.name === "string"; }

function stripOldSignatures(zip) {
  for (const name of Object.keys(zip)) {
    const upper = name.toUpperCase();
    if (upper.startsWith("META-INF/") && (
      upper === "META-INF/MANIFEST.MF" || upper.endsWith(".SF") || upper.endsWith(".RSA") || upper.endsWith(".DSA") || upper.endsWith(".EC")
    )) delete zip[name];
  }
}

function findSkinPacksDir(zip) {
  const names = Object.keys(zip).sort();
  for (const name of names) {
    const i = name.indexOf("skin_packs/");
    if (i >= 0) return name.slice(0, i + "skin_packs/".length);
  }
  return null;
}

function injectPack(apkZip, targetPrefix, packBytes) {
  for (const name of Object.keys(apkZip)) {
    if (name.startsWith(targetPrefix)) delete apkZip[name];
  }
  let packZip;
  try { packZip = unzipSync(packBytes); } catch { throw new Error("皮肤包不是有效 .mcpack/.zip"); }
  for (const [name, data] of Object.entries(packZip)) {
    if (!data || name.endsWith("/")) continue;
    const safeName = sanitizeZipName(name);
    if (!safeName) continue;
    apkZip[targetPrefix + safeName] = data;
  }
}

function sanitizeZipName(name) {
  let n = name.replace(/\\/g, "/").replace(/^\/+/, "");
  const parts = [];
  for (const p of n.split("/")) {
    if (!p || p === ".") continue;
    if (p === "..") continue;
    parts.push(p);
  }
  return parts.join("/");
}

async function addJarV1Signature(zip, keyPem, certPem) {
  const manifestSections = [];
  const main = wrapLines("Manifest-Version: 1.0\r\nCreated-By: Cloudflare MC Skin Builder\r\n\r\n");
  manifestSections.push({ name: null, text: main });

  const fileNames = Object.keys(zip)
    .filter(n => zip[n] && !n.endsWith("/"))
    .sort();

  for (const name of fileNames) {
    if (name.toUpperCase().startsWith("META-INF/")) continue;
    const digest = await sha256b64(zip[name]);
    const section = wrapManifestSection(name, digest);
    manifestSections.push({ name, text: section });
  }

  const manifest = manifestSections.map(s => s.text).join("");
  const manifestU8 = strToU8(manifest);

  let sf = "Signature-Version: 1.0\r\nCreated-By: Cloudflare MC Skin Builder\r\n";
  sf += `SHA-256-Digest-Manifest: ${await sha256b64(manifestU8)}\r\n\r\n`;
  for (const sec of manifestSections) {
    if (!sec.name) continue;
    sf += wrapLines(`Name: ${sec.name}\r\nSHA-256-Digest: ${await sha256b64(strToU8(sec.text))}\r\n\r\n`);
  }
  const sfU8 = strToU8(sf);
  const rsaU8 = makePkcs7Signature(sfU8, keyPem, certPem);

  zip["META-INF/MANIFEST.MF"] = manifestU8;
  zip["META-INF/CERT.SF"] = sfU8;
  zip["META-INF/CERT.RSA"] = rsaU8;
  return zip;
}

function wrapManifestSection(name, digest) {
  return wrapLines(`Name: ${name}\r\nSHA-256-Digest: ${digest}\r\n\r\n`);
}

function wrapLines(text) {
  const lines = text.split(/\r\n/);
  const out = [];
  for (let line of lines) {
    if (line === "") { out.push(""); continue; }
    while (byteLen(line) > 70) {
      let cut = 70;
      while (byteLen(line.slice(0, cut)) > 70) cut--;
      out.push(line.slice(0, cut));
      line = " " + line.slice(cut);
    }
    out.push(line);
  }
  return out.join("\r\n");
}

function byteLen(s) { return new TextEncoder().encode(s).length; }

async function sha256b64(u8) {
  const hash = await crypto.subtle.digest("SHA-256", u8);
  return btoa(String.fromCharCode(...new Uint8Array(hash)));
}

function u8ToBinary(u8) {
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) s += String.fromCharCode(...u8.subarray(i, i + chunk));
  return s;
}

function binaryToU8(s) {
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i) & 255;
  return u8;
}

function makePkcs7Signature(sfU8, keyPem, certPem) {
  const key = forge.pki.privateKeyFromPem(keyPem);
  const cert = forge.pki.certificateFromPem(certPem);
  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(u8ToBinary(sfU8), "binary");
  p7.addCertificate(cert);
  p7.addSigner({
    key,
    certificate: cert,
    digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest },
      { type: forge.pki.oids.signingTime, value: new Date() }
    ]
  });
  p7.sign({ detached: true });
  const der = forge.asn1.toDer(p7.toAsn1()).getBytes();
  return binaryToU8(der);
}
