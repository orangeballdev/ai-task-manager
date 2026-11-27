/* eslint-disable @next/next/no-img-element, @next/next/no-head-element, @next/next/no-page-custom-font -- static HTML generator, not a Next.js page */
// The page shell shared by the marketing page and the docs: head, top bar, footer.
import type { ReactNode } from "react";
import { GITHUB_URL, PRODUCT_NAME } from "./site-config";

export function Layout({
  title,
  description,
  prefix,
  active,
  children,
}: {
  title: string;
  description: string;
  prefix: string;
  active: "home" | "docs";
  children: ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title}</title>
        <meta name="description" content={description} />
        <meta property="og:title" content={title} />
        <meta property="og:description" content={description} />
        <meta property="og:image" content={`${prefix}screenshots/board.png`} />
        <meta name="theme-color" content="#09090b" />
        <link rel="icon" href={`${prefix}icon.svg`} type="image/svg+xml" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&family=Space+Grotesk:wght@400;500;600;700&display=swap"
        />
        <link rel="stylesheet" href={`${prefix}styles.css`} />
      </head>
      <body>
        <header className="topbar">
          <div className="topbar-inner">
            <a className="brand" href={prefix || "./"}>
              <img src={`${prefix}icon.svg`} alt="" width={22} height={22} />
              {PRODUCT_NAME}
            </a>
            <nav>
              <a href={`${prefix}#features`}>Features</a>
              <a href={`${prefix}docs/`} className={active === "docs" ? "current" : undefined}>Docs</a>
              <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer">GitHub</a>
            </nav>
          </div>
        </header>
        {children}
        <footer className="footer">
          <div className="footer-inner">
            <span>{PRODUCT_NAME} · MIT licensed · self-hosted</span>
            <span>
              <a href={`${prefix}docs/`}>Docs</a> · <a href={GITHUB_URL}>GitHub</a>
            </span>
          </div>
        </footer>
        <script dangerouslySetInnerHTML={{ __html: COPY_SCRIPT }} />
      </body>
    </html>
  );
}

/** Adds a copy button to every code block. */
const COPY_SCRIPT = `
document.querySelectorAll("pre").forEach(function (pre) {
  var b = document.createElement("button");
  b.className = "copy"; b.type = "button"; b.textContent = "Copy";
  b.addEventListener("click", function () {
    navigator.clipboard.writeText(pre.innerText.replace(/\\nCopy$/, "")).then(function () {
      b.textContent = "Copied"; setTimeout(function () { b.textContent = "Copy"; }, 1500);
    });
  });
  pre.appendChild(b);
});
var t = document.querySelector(".docs-toggle");
if (t) t.addEventListener("click", function () { document.body.classList.toggle("docs-nav-open"); });
`;
