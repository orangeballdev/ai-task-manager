/* eslint-disable @next/next/no-img-element, @next/next/no-head-element, @next/next/no-page-custom-font, @next/next/no-sync-scripts -- static HTML generator, not a Next.js page */
// The page shell shared by the marketing page and the docs: head, top bar, footer.
import type { ReactNode } from "react";
import { GITHUB_URL, OWNER_NAME, OWNER_URL, PRODUCT_NAME } from "./site-config";
import { imageInfo } from "./images";
import { OG_IMAGE, absoluteUrl, jsonLdScript } from "./seo";

export function Layout({
  title,
  description,
  prefix,
  path,
  active,
  jsonLd,
  markdownPath,
  analytics,
  children,
}: {
  title: string;
  description: string;
  prefix: string;
  /** This page's path from the site root ("" for home, "docs/mcp/"): the canonical URL. */
  path: string;
  active: "home" | "docs";
  /** schema.org objects, each written as its own JSON-LD script. */
  jsonLd: object[];
  /** Root-relative path of the page's markdown copy (docs pages), advertised to LLM tools. */
  markdownPath?: string;
  /** Load analytics/analytics.js (ObiStack user analytics, bundled by build.tsx). */
  analytics: boolean;
  children: ReactNode;
}) {
  const url = absoluteUrl(path);
  const image = absoluteUrl(OG_IMAGE);
  const imageSize = imageInfo(OG_IMAGE);
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title}</title>
        <meta name="description" content={description} />
        <link rel="canonical" href={url} />
        <meta property="og:type" content={active === "home" ? "website" : "article"} />
        <meta property="og:site_name" content={PRODUCT_NAME} />
        <meta property="og:url" content={url} />
        <meta property="og:title" content={title} />
        <meta property="og:description" content={description} />
        <meta property="og:image" content={image} />
        {imageSize && <meta property="og:image:width" content={String(imageSize.width)} />}
        {imageSize && <meta property="og:image:height" content={String(imageSize.height)} />}
        <meta property="og:image:alt" content={`The ${PRODUCT_NAME} task board`} />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content={title} />
        <meta name="twitter:description" content={description} />
        <meta name="twitter:image" content={image} />
        <link rel="sitemap" type="application/xml" href={`${prefix}sitemap.xml`} />
        {markdownPath && <link rel="alternate" type="text/markdown" href={`${prefix}${markdownPath}`} />}
        {jsonLd.map((data, i) => (
          <script key={i} type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(data) }} />
        ))}
        <meta name="theme-color" content="#09090b" />
        <link rel="icon" href={`${prefix}icon.svg`} type="image/svg+xml" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&family=Space+Grotesk:wght@400;500;600;700&display=swap"
        />
        <link rel="stylesheet" href={`${prefix}styles.css`} />
        {analytics && <script type="module" src={`${prefix}analytics/analytics.js`} />}
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
            <a className="copyright" href={OWNER_URL} target="_blank" rel="noopener noreferrer">
              <img src={`${prefix}orangeball.svg`} alt="" width={20} height={20} />
              <span>
                © {new Date().getFullYear()} {OWNER_NAME}
              </span>
            </a>
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
