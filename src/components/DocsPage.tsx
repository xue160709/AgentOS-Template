type DocsPageProps = { hidden: boolean }

export function DocsPage({ hidden }: DocsPageProps) {
  return (
    <section className="app-main-inner" id="panel-docs" hidden={hidden} aria-hidden={hidden}>
      <div className="app-main-eyebrow">文档</div>
      <h1 className="app-main-heading">文档</h1>
      <section className="app-panel">
        <p className="text-token-secondary" style={{ margin: 0 }}>
          文档视图占位。可在此接入路由或 Webview。
        </p>
      </section>
    </section>
  )
}
