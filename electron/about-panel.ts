/**
 * macOS「关于」面板与跨平台 about 元数据。
 * macOS About panel and shared about metadata.
 */

import { app } from 'electron'
import { APP_METADATA, appCopyrightLine } from '../src/app-metadata'

export function installAboutPanel(): void {
  const credits = [
    APP_METADATA.authorName,
    APP_METADATA.authorEmail,
    `WeChat: ${APP_METADATA.authorWeChat}`,
  ].join('\n')

  app.setAboutPanelOptions({
    applicationName: APP_METADATA.productName,
    applicationVersion: app.getVersion(),
    version: app.getVersion(),
    copyright: appCopyrightLine(),
    credits,
    website: APP_METADATA.homepage,
  })
}
