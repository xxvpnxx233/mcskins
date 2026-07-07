# MC APK Skin Builder - Cloudflare Worker 版

这个项目可以直接导入 Cloudflare Workers：

1. 把本目录上传到 GitHub/GitLab。
2. Cloudflare Dashboard → Workers & Pages → Create → Import a repository。
3. Framework preset 选 `None`。
4. Build command 留空或填：`npm install`。
5. Deploy command 使用：`npm run deploy`，或直接用 Wrangler 部署。

本项目提供：

- `/`：网页上传界面
- `/api/build`：上传 APK、custom 皮肤包、persona 皮肤包，自动注入到 APK 的 `*/skin_packs/custom/` 和 `*/skin_packs/persona/`
- 输出重新 ZIP 并进行 APK v1/JAR 签名

## Cloudflare 限制

Cloudflare Worker 不能运行 `apktool`、`zipalign`、`apksigner` 这类系统二进制，所以这里使用纯 JS：

- `fflate` 修改 APK ZIP
- `node-forge` 生成 v1/JAR 签名

如果 APK 或目标 Android 环境强制要求 APK Signature Scheme v2/v3/v4，则需要把 `/api/build` 改成转发到 VPS/容器后端使用 Android Build Tools 签名。

## 签名密钥

部署后在 Cloudflare 设置两个 Secret：

```bash
wrangler secret put SIGN_KEY_PEM
wrangler secret put SIGN_CERT_PEM
```

如果不设置，网页会提示缺少签名密钥。

`SIGN_KEY_PEM` 是 RSA 私钥 PEM，例如：

```text
-----BEGIN RSA PRIVATE KEY-----
...
-----END RSA PRIVATE KEY-----
```

`SIGN_CERT_PEM` 是 X.509 证书 PEM，例如：

```text
-----BEGIN CERTIFICATE-----
...
-----END CERTIFICATE-----
```

## 表单字段

`POST /api/build` 使用 `multipart/form-data`：

- `apk`
- `custom_pack`
- `persona_pack`

## 输出

返回：

```text
application/vnd.android.package-archive
```
