import { unzipSync, zipSync, strToU8, strFromU8 } from "fflate";
import forge from "node-forge";

const OUTPUT_PACKAGE_NAME = "com.mojang.xxvpnxx";

const HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>MC APK ??????</title>
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
    <h1>MC APK ??????</h1>
    <p class="hint">?? APK?custom ????persona ????????????????? APK ???????? <code>*/skin_packs/custom/</code> ? <code>*/skin_packs/persona/</code>??????? <code>com.mojang.xxvpnxx</code>???????????</p>
    <form id="f">
      <div class="row"><label>APK ??</label><input name="apk" type="file" accept=".apk,application/vnd.android.package-archive" required></div>
      <div class="row"><label>custom ????.mcpack/.zip?</label><input name="custom_pack" type="file" accept=".mcpack,.zip" required></div>
      <div class="row"><label>persona ????.mcpack/.zip?</label><input name="persona_pack" type="file" accept=".mcpack,.zip" required></div>
      <button id="btn">????</button>
    </form>
    <div id="log" class="log">????...</div>
  </div>
<script>
const form=document.getElementById('f');const log=document.getElementById('log');const btn=document.getElementById('btn');
form.onsubmit=async e=>{e.preventDefault();btn.disabled=true;log.textContent='????? APK ?...';
 try{const res=await fetch('/api/build',{method:'POST',body:new FormData(form)});if(!res.ok){throw new Error(await res.text())}
 const blob=await res.blob();const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='minecraft_skin_signed.apk';a.click();URL.revokeObjectURL(url);log.innerHTML='<span class="ok">?????????</span>';
 }catch(err){log.innerHTML='<span class="err">???'+String(err.message||err).replace(/[<>&]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]))+'</span>'}
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
    return new Response("缂哄皯 Cloudflare Secret锛歋IGN_KEY_PEM 鎴?SIGN_CERT_PEM", { status: 500 });
  }

  const form = await request.formData();
  const apk = form.get("apk");
  const custom = form.get("custom_pack");
  const persona = form.get("persona_pack");
  if (!isFile(apk) || !isFile(custom) || !isFile(persona)) {
    return new Response("闇€瑕佷笂浼?apk銆乧ustom_pack銆乸ersona_pack 涓変釜鏂囦欢", { status: 400 });
  }

  const apkBytes = new Uint8Array(await apk.arrayBuffer());
  const customBytes = new Uint8Array(await custom.arrayBuffer());
  const personaBytes = new Uint8Array(await persona.arrayBuffer());

  let apkZip;
  try { apkZip = unzipSync(apkBytes); } catch { return new Response("APK ???? ZIP/APK ??", { status: 400 }); }

  stripOldSignatures(apkZip);
  patchPackageName(apkZip, OUTPUT_PACKAGE_NAME);
  const skinRoot = findSkinPacksDir(apkZip);
  if (!skinRoot) return new Response("APK ????? */skin_packs/ ??", { status: 400 });

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

function patchPackageName(apkZip, newPackageName) {
  const manifestName = "AndroidManifest.xml";
  const manifest = apkZip[manifestName];
  if (!manifest) throw new Error("APK ??? AndroidManifest.xml");
  const asText = tryUtf8(manifest);
  if (asText && asText.includes("package=")) {
    const patched = asText.replace(/package=(["'])([^"']+)\1/, `package="${newPackageName}"`);
    apkZip[manifestName] = strToU8(patched);
    return;
  }
  apkZip[manifestName] = patchBinaryXmlStringPool(manifest, newPackageName);
}
function tryUtf8(u8) { try { const s = strFromU8(u8); return s.includes("<manifest") ? s : null; } catch { return null; } }
function patchBinaryXmlStringPool(axml, newPackageName) {
  const bytes = axml instanceof Uint8Array ? axml : new Uint8Array(axml);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (rd16(dv, 0) !== 0x0003) throw new Error("AndroidManifest.xml ???? binary XML");
  const xmlChunkSize = rd32(dv, 4);
  let off = rd16(dv, 2);
  while (off + 8 <= bytes.length) {
    const type = rd16(dv, off), headerSize = rd16(dv, off + 2), chunkSize = rd32(dv, off + 4);
    if (type === 0x0001) {
      const stringCount = rd32(dv, off + 8), styleCount = rd32(dv, off + 12), flags = rd32(dv, off + 16), stringsStart = rd32(dv, off + 20), stylesStart = rd32(dv, off + 24);
      const isUtf8 = (flags & 0x00000100) !== 0;
      const strings = [];
      for (let i = 0; i < stringCount; i++) strings.push(readPoolString(bytes, off + stringsStart + rd32(dv, off + headerSize + i * 4), isUtf8).value);
      const pkgIndex = findLikelyPackageString(strings);
      if (pkgIndex < 0) throw new Error("??? AndroidManifest.xml ????????????????");
      strings[pkgIndex] = newPackageName;
      const rebuilt = rebuildStringPoolChunk(bytes, off, headerSize, chunkSize, stringCount, styleCount, strings, isUtf8, stylesStart);
      const delta = rebuilt.length - chunkSize;
      const out = new Uint8Array(bytes.length + delta);
      out.set(bytes.slice(0, off), 0); out.set(rebuilt, off); out.set(bytes.slice(off + chunkSize), off + rebuilt.length);
      wr32(new DataView(out.buffer), 4, xmlChunkSize + delta);
      return out;
    }
    off += chunkSize;
  }
  throw new Error("AndroidManifest.xml ???? string pool");
}
function findLikelyPackageString(strings) {
  let exact = strings.indexOf("com.mojang.minecraftpe"); if (exact >= 0) return exact;
  exact = strings.findIndex(s => /^com\.mojang\.[A-Za-z0-9_.]+$/.test(s)); if (exact >= 0) return exact;
  return strings.findIndex(s => /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){2,}$/.test(s));
}
function rebuildStringPoolChunk(oldBytes, off, headerSize, oldChunkSize, stringCount, styleCount, strings, isUtf8, oldStylesStart) {
  const styleOffsetsLen = styleCount * 4;
  const styleBytes = styleCount && oldStylesStart ? oldBytes.slice(off + oldStylesStart, off + oldChunkSize) : new Uint8Array();
  const stringParts = [], newOffsets = []; let cursor = 0;
  for (const s of strings) { newOffsets.push(cursor); const enc = isUtf8 ? encodePoolStringUtf8(s) : encodePoolStringUtf16(s); stringParts.push(enc); cursor += enc.length; }
  const stringsBlobLen = align4(cursor), stringsBlob = new Uint8Array(stringsBlobLen); let p = 0;
  for (const part of stringParts) { stringsBlob.set(part, p); p += part.length; }
  const stringsStart = headerSize + stringCount * 4 + styleOffsetsLen, stylesStart = styleCount ? stringsStart + stringsBlobLen : 0, newChunkSize = stringsStart + stringsBlobLen + styleBytes.length;
  const out = new Uint8Array(newChunkSize); out.set(oldBytes.slice(off, off + headerSize), 0); const dv = new DataView(out.buffer);
  wr32(dv, 4, newChunkSize); wr32(dv, 20, stringsStart); wr32(dv, 24, stylesStart);
  for (let i = 0; i < stringCount; i++) wr32(dv, headerSize + i * 4, newOffsets[i]);
  if (styleOffsetsLen) out.set(oldBytes.slice(off + headerSize + stringCount * 4, off + headerSize + stringCount * 4 + styleOffsetsLen), headerSize + stringCount * 4);
  out.set(stringsBlob, stringsStart); if (styleBytes.length) out.set(styleBytes, stylesStart); return out;
}
function readPoolString(bytes, pos, isUtf8) {
  if (isUtf8) { const a = readLen8(bytes, pos); pos += a.size; const b = readLen8(bytes, pos); pos += b.size; return { value: strFromU8(bytes.slice(pos, pos + b.len)) }; }
  const a = readLen16(bytes, pos); pos += a.size; const data = bytes.slice(pos, pos + a.len * 2); let value = "";
  for (let i = 0; i < data.length; i += 2) value += String.fromCharCode(data[i] | (data[i + 1] << 8)); return { value };
}
function encodePoolStringUtf8(s) { const u8 = strToU8(s); return concatU8(encodeLen8([...s].length), encodeLen8(u8.length), u8, new Uint8Array([0])); }
function encodePoolStringUtf16(s) { const len = encodeLen16(s.length), data = new Uint8Array(s.length * 2); for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); data[i * 2] = c & 255; data[i * 2 + 1] = c >> 8; } return concatU8(len, data, new Uint8Array([0, 0])); }
function readLen8(bytes, pos) { const first = bytes[pos]; return (first & 0x80) === 0 ? { len: first, size: 1 } : { len: ((first & 0x7f) << 8) | bytes[pos + 1], size: 2 }; }
function readLen16(bytes, pos) { const first = bytes[pos] | (bytes[pos + 1] << 8); if ((first & 0x8000) === 0) return { len: first, size: 2 }; const second = bytes[pos + 2] | (bytes[pos + 3] << 8); return { len: ((first & 0x7fff) << 16) | second, size: 4 }; }
function encodeLen8(len) { return len < 0x80 ? new Uint8Array([len]) : new Uint8Array([(len >> 8) | 0x80, len & 255]); }
function encodeLen16(len) { return len < 0x8000 ? new Uint8Array([len & 255, len >> 8]) : new Uint8Array([((len >> 16) & 0x7f) | 0x80, (len >> 24) & 255, len & 255, (len >> 8) & 255]); }
function concatU8(...parts) { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let off = 0; for (const p of parts) { out.set(p, off); off += p.length; } return out; }
function align4(n) { return (n + 3) & ~3; }
function rd16(dv, p) { return dv.getUint16(p, true); }
function rd32(dv, p) { return dv.getUint32(p, true); }
function wr32(dv, p, v) { dv.setUint32(p, v >>> 0, true); }


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
  try { packZip = unzipSync(packBytes); } catch { throw new Error("鐨偆鍖呬笉鏄湁鏁?.mcpack/.zip"); }
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



