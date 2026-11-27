import {
  Children,
  isValidElement,
  memo,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy, FileCode2 } from "lucide-react";
import { chatUrlTransform, normalizeChatMarkdownMath } from "./chatMarkdownMath";

interface NativeChatProseProps {
  content: string;
  /** Tighter spacing for inline prompt/receipt cards. */
  compact?: boolean;
}

const REMARK_PLUGINS = [remarkGfm];

export const NativeChatProse = memo(function NativeChatProse({
  content,
  compact = false,
}: NativeChatProseProps) {
  const normalized = useMemo(() => normalizeChatMarkdownMath(content), [content]);

  return (
    <div
      className={`${
        compact ? "space-y-1 text-[13px] leading-snug" : "space-y-2.5 text-[13.5px] leading-[1.65]"
      } text-fg-soft break-words [overflow-wrap:anywhere] min-w-0 max-w-full`}
    >
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        urlTransform={chatUrlTransform}
        components={COMPONENTS}
      >
        {normalized}
      </ReactMarkdown>
    </div>
  );
});

function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore
    }
  };

  return (
    <div className="my-2 rounded-lg overflow-hidden border border-line bg-[#10100f] text-[12px] font-mono min-w-0 max-w-full">
      <div className="flex items-center justify-between px-3 py-1 bg-sidebar border-b border-line text-dim">
        <span className="text-[11px] lowercase text-accent-soft/80">{lang || "text"}</span>
        <button
          type="button"
          onClick={handleCopy}
          className="flex items-center gap-1 text-dim hover:text-fg transition-colors"
          title="Copy code"
        >
          {copied ? <Check className="w-3 h-3 text-status-ok" /> : <Copy className="w-3 h-3" />}
          <span className="text-[10.5px] font-sans">{copied ? "Copied" : "Copy"}</span>
        </button>
      </div>
      <pre className="p-3 overflow-x-auto text-fg-soft leading-[1.55] scrollbar-thin max-w-full">
        <code>{code}</code>
      </pre>
    </div>
  );
}

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement(node))
    return textOf((node as ReactElement<{ children?: ReactNode }>).props.children);
  return "";
}

const heading = (level: 2 | 3 | 4 | 5 | 6, cls: string) =>
  function Heading({ children }: { children?: ReactNode }) {
    return (
      <div role="heading" aria-level={level} className={`font-semibold text-fg ${cls}`}>
        {children}
      </div>
    );
  };

const COMPONENTS: Components = {
  pre({ children }) {
    const child = Children.toArray(children)[0];
    const props = isValidElement(child)
      ? (child as ReactElement<{ className?: string; children?: ReactNode }>).props
      : {};
    const lang = /language-([\w-]+)/.exec(props.className ?? "")?.[1];
    return <CodeBlock code={textOf(props.children).replace(/\n$/, "")} lang={lang} />;
  },
  code({ children, className }) {
    return (
      <code
        className={`px-[5px] py-[1px] rounded-[4px] bg-surface border border-line text-[#e5c488] font-mono text-[0.875em] break-all [overflow-wrap:anywhere] ${className ?? ""}`}
      >
        {children}
      </code>
    );
  },
  p: ({ children }) => <p className="break-words [overflow-wrap:anywhere]">{children}</p>,
  strong: ({ children }) => <strong className="font-semibold text-fg">{children}</strong>,
  del: ({ children }) => <del className="text-muted">{children}</del>,
  h1: heading(2, "text-[16px] tracking-tight mt-3"),
  h2: heading(3, "text-[15px] tracking-tight mt-2.5"),
  h3: heading(4, "text-[14px] tracking-tight mt-2"),
  h4: heading(5, "text-[13.5px] mt-2"),
  h5: heading(6, "text-[13.5px] mt-2"),
  h6: heading(6, "text-[13.5px] mt-2"),
  ul: ({ children }) => (
    <ul className="list-disc pl-5 space-y-1 marker:text-accent/70">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="list-decimal pl-6 space-y-1 marker:text-accent/70 marker:tabular-nums">
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="pl-0.5 [&>ul]:mt-1 [&>ol]:mt-1">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-accent/55 pl-3 text-fg-soft/85">{children}</blockquote>
  ),
  hr: () => <hr className="border-line my-2.5" />,
  a: ({ href, children }) => {
    if (href && href.startsWith("file://")) {
      const cleanPath = decodeURIComponent(href.replace(/^file:\/\//, ""));
      return (
        <span
          title={cleanPath}
          className="inline-flex items-center gap-1 px-1.5 py-[1px] rounded-[4px] bg-surface border border-line-strong/80 text-accent-soft font-mono text-[0.86em] align-baseline break-all"
        >
          <FileCode2 className="w-3 h-3 shrink-0 inline text-accent" />
          <span>{children}</span>
        </span>
      );
    }
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-accent-soft underline underline-offset-3 decoration-accent/40 hover:decoration-accent-soft break-all transition-colors"
      >
        {children}
      </a>
    );
  },
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto rounded-lg border border-line max-w-full">
      <table className="w-full text-left text-[12.5px] border-collapse">{children}</table>
    </div>
  ),
  thead: ({ children }) => (
    <thead className="bg-sidebar text-fg text-[11.5px] border-b border-line">{children}</thead>
  ),
  tr: ({ children }) => <tr className="border-b border-line last:border-b-0">{children}</tr>,
  th: ({ children }) => <th className="px-2.5 py-1.5 font-semibold">{children}</th>,
  td: ({ children }) => <td className="px-2.5 py-1.5 align-top">{children}</td>,
  img: ({ src, alt }) =>
    src && /^https?:\/\//i.test(src) ? (
      <a
        href={src}
        target="_blank"
        rel="noopener noreferrer"
        className="text-fg underline underline-offset-2 decoration-line-strong break-all"
      >
        {alt || src}
      </a>
    ) : (
      <span className="text-muted italic">[image{alt ? `: ${alt}` : ""}]</span>
    ),
};
