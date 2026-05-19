#!/usr/bin/env bash
# 本地打包用环境变量（勿提交真实密码）
# cp scripts/release-env.example.sh scripts/release-env.local.sh

# macOS 签名：本机钥匙串有证书时用 CSC_NAME
# export CSC_NAME="Developer ID Application: Your Name (TEAMID)"

# macOS 公证（与 APPLE_ID + 专用密码配合时必填）
# export APPLE_TEAM_ID="XXXXXXXXXX"

# macOS 签名：或用 .p12
# export CSC_LINK="/path/to/certificate.p12"
# export CSC_KEY_PASSWORD="p12-password"

# macOS 公证
export APPLE_ID="you@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="TEAMID"

# Windows 签名（可选）
# export WIN_CSC_LINK="/path/to/certificate.pfx"
# export WIN_CSC_KEY_PASSWORD="pfx-password"
