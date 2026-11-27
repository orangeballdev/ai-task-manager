"use client";

import { useState, useEffect } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Monitor,
  Download,
  Maximize2,
  Minimize2,
  Code2,
  FileText,
  Table2,
} from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { MarkdownRenderer } from "@/components/MarkdownRenderer";
import { CsvRenderer } from "@/components/CsvRenderer";
import {
  MARKDOWN_EXTENSIONS,
  SLIDESHOW_EXTENSIONS,
  getFileExt,
} from "@/lib/file-icons";

/** Returns true if a file path/name represents a slideshow */
export function detectSlideshow(filePath: string, ext: string, content?: string): boolean {
  // .slides extension
  if (SLIDESHOW_EXTENSIONS.has(ext)) return true;
  // .slides.md filename
  const name = filePath.split("/").pop() ?? "";
  if (name.endsWith(".slides.md")) return true;
  // Marp front matter in markdown
  if (content && MARKDOWN_EXTENSIONS.has(ext)) {
    const start = content.trimStart();
    if (start.startsWith("---") && /marp:\s*true/i.test(start.slice(0, 500))) return true;
  }
  return false;
}

/**
 * Parse a markdown-style slideshow into individual slides.
 * Handles optional YAML front matter (skipped).
 * Slides are separated by lines containing only "---".
 */
function parseSlides(content: string): string[] {
  const lines = content.split("\n");
  let start = 0;

  // Skip YAML front matter: starts with "---", ends at next "---"
  if (lines[0]?.trim() === "---") {
    let end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
    if (end === -1) end = 0;
    start = end + 1;
  }

  const slides: string[] = [];
  let currentSlide: string[] = [];

  for (let i = start; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      const slideContent = currentSlide.join("\n").trim();
      if (slideContent) slides.push(slideContent);
      currentSlide = [];
    } else {
      currentSlide.push(lines[i]);
    }
  }

  const last = currentSlide.join("\n").trim();
  if (last) slides.push(last);

  return slides.length > 0 ? slides : [content];
}

/** Generate a self-contained HTML presentation for download */
function generateSlideshowHtml(slides: string[], title: string): string {
  const slideDivs = slides
    .map(
      (s, i) => `
  <div class="slide${i === 0 ? " active" : ""}" id="slide-${i}">
    <div class="slide-content">${markdownToSimpleHtml(s)}</div>
  </div>`
    )
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, sans-serif; background: #0f172a; color: #f1f5f9; height: 100vh; overflow: hidden; }
  .slide { display: none; position: absolute; inset: 0; align-items: center; justify-content: center; padding: 4rem; }
  .slide.active { display: flex; }
  .slide-content { max-width: 900px; width: 100%; }
  .slide-content h1 { font-size: 2.5rem; font-weight: 700; margin-bottom: 1rem; color: #f8fafc; }
  .slide-content h2 { font-size: 2rem; font-weight: 600; margin-bottom: 0.75rem; color: #f8fafc; }
  .slide-content h3 { font-size: 1.5rem; font-weight: 600; margin-bottom: 0.5rem; }
  .slide-content p { font-size: 1.25rem; line-height: 1.6; margin-bottom: 1rem; color: #e2e8f0; }
  .slide-content ul, .slide-content ol { font-size: 1.2rem; margin: 0.5rem 0 1rem 1.5rem; line-height: 1.7; }
  .slide-content li { margin-bottom: 0.4rem; color: #e2e8f0; }
  .slide-content code { background: #1e293b; padding: 0.1em 0.4em; border-radius: 4px; font-family: monospace; }
  .slide-content pre { background: #1e293b; padding: 1rem; border-radius: 8px; overflow-x: auto; margin: 1rem 0; }
  .slide-content strong { color: #f8fafc; }
  .nav { position: fixed; bottom: 1.5rem; left: 50%; transform: translateX(-50%); display: flex; align-items: center; gap: 1rem; background: rgba(30,41,59,0.9); padding: 0.5rem 1rem; border-radius: 9999px; backdrop-filter: blur(8px); }
  .nav button { background: none; border: none; color: #94a3b8; cursor: pointer; font-size: 1.25rem; padding: 0.25rem 0.5rem; border-radius: 4px; transition: color 0.15s; }
  .nav button:hover { color: #f1f5f9; }
  .nav .counter { color: #94a3b8; font-size: 0.875rem; min-width: 4rem; text-align: center; }
  #slides-container { position: relative; height: 100vh; }
</style>
</head>
<body>
<div id="slides-container">
${slideDivs}
</div>
<nav class="nav">
  <button id="prev" onclick="prev()">&#8592;</button>
  <span class="counter" id="counter">1 / ${slides.length}</span>
  <button id="next" onclick="next()">&#8594;</button>
</nav>
<script>
  let current = 0;
  const total = ${slides.length};
  function show(n) {
    document.querySelectorAll('.slide').forEach(s => s.classList.remove('active'));
    document.getElementById('slide-' + n).classList.add('active');
    document.getElementById('counter').textContent = (n+1) + ' / ' + total;
    current = n;
  }
  function prev() { show(Math.max(0, current - 1)); }
  function next() { show(Math.min(total - 1, current + 1)); }
  document.addEventListener('keydown', e => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === ' ') next();
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') prev();
  });
</script>
</body>
</html>`;
}

function escapeHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Very simple markdown→HTML for the exported standalone HTML */
function markdownToSimpleHtml(md: string): string {
  return md
    .replace(/^### (.+)$/gm, "<h3>$1</h3>")
    .replace(/^## (.+)$/gm, "<h2>$1</h2>")
    .replace(/^# (.+)$/gm, "<h1>$1</h1>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/`(.+?)`/g, "<code>$1</code>")
    .replace(/^[-*] (.+)$/gm, "<li>$1</li>")
    .replace(/(<li>.*<\/li>\n?)+/g, (m) => `<ul>${m}</ul>`)
    .replace(/^\d+\. (.+)$/gm, "<li>$1</li>")
    .replace(/^(?!<[hul]|<li)(.+)$/gm, "<p>$1</p>")
    .replace(/\n{2,}/g, "\n");
}

/** Interactive slideshow viewer */
function SlideViewer({ content, fileName }: { content: string; fileName: string }) {
  const slides = parseSlides(content);
  const [current, setCurrent] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);

  const prev = () => setCurrent((c) => Math.max(0, c - 1));
  const next = () => setCurrent((c) => Math.min(slides.length - 1, c + 1));

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "ArrowRight" || e.key === "ArrowDown") next();
      if (e.key === "ArrowLeft" || e.key === "ArrowUp") prev();
      if (e.key === "Escape" && fullscreen) setFullscreen(false);
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fullscreen, slides.length]);

  function downloadHtml() {
    const title = fileName.replace(/\.slides\.md$|\.slides$|\.md$/, "");
    const html = generateSlideshowHtml(slides, title);
    const blob = new Blob([html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${title}.html`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const slide = slides[current];
  const isFirst = current === 0;
  const isLast = current === slides.length - 1;

  return (
    <div className={fullscreen ? "fixed inset-0 z-50 bg-background flex flex-col" : "flex flex-col gap-0"}>
      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-muted/30">
        <div className="flex items-center gap-2">
          <Monitor className="size-4 text-pink-400" />
          <span className="text-sm font-medium text-foreground">{fileName}</span>
          <span className="text-xs text-muted-foreground">
            · {slides.length} slide{slides.length !== 1 ? "s" : ""}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            className="h-7 gap-1.5 text-xs"
            onClick={downloadHtml}
            title="Download as HTML presentation"
          >
            <Download className="size-3.5" />
            Download HTML
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 w-7 p-0"
            onClick={() => setFullscreen((f) => !f)}
            title={fullscreen ? "Exit fullscreen" : "Fullscreen"}
          >
            {fullscreen ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
          </Button>
        </div>
      </div>

      {/* Slide area */}
      <div className="relative flex-1 flex flex-col items-center justify-center min-h-[60vh] bg-gradient-to-br from-slate-900/40 to-slate-800/20 p-8 sm:p-16">
        <div className="w-full max-w-3xl">
          <MarkdownRenderer
            content={slide}
            className="text-base [&_h1]:text-3xl [&_h1]:font-bold [&_h1]:mb-4 [&_h2]:text-2xl [&_h2]:font-semibold [&_h2]:mb-3 [&_h3]:text-xl [&_h3]:font-semibold [&_h3]:mb-2 [&_p]:text-lg [&_p]:leading-relaxed [&_ul]:text-lg [&_li]:py-0.5"
          />
        </div>

        {/* Prev/Next buttons */}
        <button
          onClick={prev}
          disabled={isFirst}
          className="absolute left-3 top-1/2 -translate-y-1/2 p-2 rounded-full bg-muted/50 hover:bg-muted disabled:opacity-20 transition-all"
          aria-label="Previous slide"
        >
          <ChevronLeft className="size-5" />
        </button>
        <button
          onClick={next}
          disabled={isLast}
          className="absolute right-3 top-1/2 -translate-y-1/2 p-2 rounded-full bg-muted/50 hover:bg-muted disabled:opacity-20 transition-all"
          aria-label="Next slide"
        >
          <ChevronRight className="size-5" />
        </button>
      </div>

      {/* Footer: slide counter + dots */}
      <div className="flex items-center justify-center gap-3 py-3 border-t border-border bg-muted/20">
        {/* Dot indicators (up to 20 dots) */}
        {slides.length <= 20 && (
          <div className="flex items-center gap-1">
            {slides.map((_, i) => (
              <button
                key={i}
                onClick={() => setCurrent(i)}
                className={`size-1.5 rounded-full transition-all ${
                  i === current
                    ? "bg-foreground scale-125"
                    : "bg-muted-foreground/40 hover:bg-muted-foreground/70"
                }`}
                aria-label={`Go to slide ${i + 1}`}
              />
            ))}
          </div>
        )}
        <span className="text-xs text-muted-foreground tabular-nums">
          {current + 1} / {slides.length}
        </span>
      </div>
    </div>
  );
}

/** Generic toolbar + fullscreen wrapper, shared by every content type so they all get the same expand control. */
function FullscreenFrame({
  fileName,
  icon,
  children,
  showLabel = true,
  hideToolbar = false,
  fullscreen: controlledFullscreen,
  onFullscreenChange,
}: {
  fileName: string;
  icon: ReactNode;
  children: (fullscreen: boolean) => ReactNode;
  /** Set false when the surrounding page already shows the filename, to avoid a redundant label. */
  showLabel?: boolean;
  /**
   * When true, this component renders no toolbar of its own (no filename label,
   * no fullscreen button) — used when the surrounding page hosts its own
   * view-toggle row and wants the fullscreen control merged into that row
   * instead of getting a second, mostly-empty bar underneath it.
   */
  hideToolbar?: boolean;
  /** Externally controlled fullscreen state; falls back to internal state when omitted. */
  fullscreen?: boolean;
  onFullscreenChange?: (fullscreen: boolean) => void;
}) {
  const [internalFullscreen, setInternalFullscreen] = useState(false);
  const fullscreen = controlledFullscreen ?? internalFullscreen;
  const setFullscreen = onFullscreenChange ?? setInternalFullscreen;

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape" && fullscreen) setFullscreen(false);
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [fullscreen, setFullscreen]);

  // When the toolbar is hidden, the parent already owns fullscreen positioning
  // (its own fixed/inset wrapper), so just render the content with no extra frame.
  if (hideToolbar) {
    return <>{children(fullscreen)}</>;
  }

  return (
    <div className={fullscreen ? "fixed inset-0 z-50 bg-background flex flex-col" : "flex flex-col gap-0"}>
      {/* Toolbar */}
      <div className="flex items-center justify-end px-4 py-2 border-b border-border bg-muted/30">
        {showLabel && (
          <div className="flex items-center gap-2 min-w-0 mr-auto">
            {icon}
            <span className="text-sm font-medium text-foreground truncate">{fileName}</span>
          </div>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="h-7 w-7 p-0 shrink-0"
          onClick={() => setFullscreen(!fullscreen)}
          title={fullscreen ? "Exit fullscreen" : "Fullscreen"}
        >
          {fullscreen ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
        </Button>
      </div>

      <div className={fullscreen ? "flex-1 overflow-auto" : undefined}>{children(fullscreen)}</div>
    </div>
  );
}

/** Sandboxed iframe for standalone HTML files (e.g. generated presentations). */
function HtmlViewer({ content, fileName, showLabel, fullscreenProps }: { content: string; fileName: string; showLabel?: boolean; fullscreenProps?: FullscreenControlProps }) {
  return (
    <FullscreenFrame fileName={fileName} icon={<Code2 className="size-4 text-muted-foreground shrink-0" />} showLabel={showLabel} {...fullscreenProps}>
      {(fullscreen) => (
        // `allow-scripts` lets self-contained pages run their own JS (e.g. slide nav);
        // without `allow-same-origin` the document stays isolated from the app.
        <iframe
          srcDoc={content}
          title={fileName}
          sandbox="allow-scripts"
          className={fullscreen ? "w-full h-full border-0 bg-white" : "w-full h-[75vh] min-h-[480px] border-0 bg-white"}
        />
      )}
    </FullscreenFrame>
  );
}

/** Shared shape for lifting the fullscreen toggle out to a parent-hosted control. */
interface FullscreenControlProps {
  hideToolbar?: boolean;
  fullscreen?: boolean;
  onFullscreenChange?: (fullscreen: boolean) => void;
}

interface FileContentViewProps {
  content: string;
  fileName: string;
  /** Override the detected extension (e.g. when the server already resolved it). */
  ext?: string;
  /**
   * When true, a file with no extension at all renders as markdown rather than
   * plain monospace text. Used by the output-files feature, where extension-less
   * legacy documents are markdown. Files with an unrecognized extension still
   * fall back to the raw monospace view.
   */
  markdownFallback?: boolean;
  /** Set false when the surrounding page already shows the filename, to avoid a redundant label. */
  showLabel?: boolean;
  /**
   * Lets a parent page host the fullscreen toggle button itself (e.g. merged
   * into a view-mode toolbar) instead of getting a second toolbar row.
   */
  fullscreenProps?: FullscreenControlProps;
}

/**
 * Renders file content according to its type: slideshows, markdown, CSV tables,
 * or monospace code/plain text. Anything without a dedicated renderer falls back
 * to a raw monospace view. Shared by the workspace file browser and the
 * output-files viewer so both render identically.
 */
export function FileContentView({ content, fileName, ext, markdownFallback = false, showLabel = true, fullscreenProps }: FileContentViewProps) {
  const resolvedExt = ext ?? getFileExt(fileName);

  if (detectSlideshow(fileName, resolvedExt, content)) {
    return <SlideViewer content={content} fileName={fileName} />;
  }

  if (resolvedExt === "html" || resolvedExt === "htm") {
    return <HtmlViewer content={content} fileName={fileName} showLabel={showLabel} fullscreenProps={fullscreenProps} />;
  }

  if (resolvedExt === "csv") {
    return (
      <FullscreenFrame fileName={fileName} icon={<Table2 className="size-4 text-muted-foreground shrink-0" />} showLabel={showLabel} {...fullscreenProps}>
        {() => (
          <div className="p-4 sm:p-6">
            <CsvRenderer content={content} />
          </div>
        )}
      </FullscreenFrame>
    );
  }

  const isMarkdown = MARKDOWN_EXTENSIONS.has(resolvedExt);
  const noExt = resolvedExt === "";

  if (isMarkdown || (noExt && markdownFallback)) {
    return (
      <FullscreenFrame fileName={fileName} icon={<FileText className="size-4 text-blue-400 shrink-0" />} showLabel={showLabel} {...fullscreenProps}>
        {() => (
          <div className="prose-container max-w-none p-4 sm:p-6">
            <MarkdownRenderer content={content} className="text-sm" />
          </div>
        )}
      </FullscreenFrame>
    );
  }

  // Code, JSON/config, and any other/unknown type fall back to a raw monospace view.
  return (
    <FullscreenFrame fileName={fileName} icon={<Code2 className="size-4 text-muted-foreground shrink-0" />} showLabel={showLabel} {...fullscreenProps}>
      {() => (
        <pre className="text-sm font-mono text-foreground whitespace-pre overflow-x-auto leading-relaxed p-4 sm:p-6">
          <code>{content}</code>
        </pre>
      )}
    </FullscreenFrame>
  );
}
