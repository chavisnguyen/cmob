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

/** Agent output rendered as GitHub-flavoured markdown. Raw HTML is never interpreted (react-markdown default). */
export const NativeChatProse = memo(function NativeChatProse({
  content,
  compact = false,
}: NativeChatProseProps) {
  const normalized = useMemo(() => normalizeChatMarkdownMath(content), [content]);

  return (
    <div
      className={`${
        compact ? "space-y-1 text-[13px] leading-snug" : "space-y-2.5 text-[14px] leading-[1.65]"
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
    <div className="my-2.5 rounded-xl overflow-hidden border border-white/[0.07] bg-[#0c0d0f] text-[12.5px] font-mono min-w-0 max-w-full">
      <div className="flex items-center justify-between px-3 py-1.5 bg-white/[0.02] border-b border-white/[0.06] text-dim">
        <span className="text-[11px] font-medium lowercase">{lang || "text"}</span>
        <button
          type="button"
          onClick={handleCopy}
          className="flex items-center gap-1 text-muted hover:text-fg transition-colors"
          title="Copy code"
        >
          {copied ? (
            <Check className="w-3.5 h-3.5 text-emerald-400" />
          ) : (
            <Copy className="w-3.5 h-3.5" />
          )}
          <span className="text-[10.5px] font-sans">{copied ? "Copied" : "Copy"}</span>
        </button>
      </div>
      <pre className="p-3.5 overflow-x-auto text-fg-soft leading-[1.55] scrollbar-thin max-w-full">
        <code>{code}</code>
      </pre>
    </div>
  );
}

/** Plain text of a React subtree (code blocks arrive as a single string child). */
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
      <div role="heading" aria-level={level} className={`font-semibold text-white ${cls}`}>
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
        className={`px-[5px] py-[1px] rounded-[5px] bg-white/[0.055] border border-white/[0.08] text-fg font-mono text-[0.875em] break-all [overflow-wrap:anywhere] ${className ?? ""}`}
      >
        {children}
      </code>
    );
  },
  p: ({ children }) => <p className="break-words [overflow-wrap:anywhere]">{children}</p>,
  strong: ({ children }) => <strong className="font-semibold text-fg">{children}</strong>,
  del: ({ children }) => <del className="text-muted">{children}</del>,
  h1: heading(2, "text-[16.5px] tracking-tight mt-3"),
  h2: heading(3, "text-[15.5px] tracking-tight mt-2.5"),
  h3: heading(4, "text-[14.5px] tracking-tight mt-2"),
  h4: heading(5, "text-[14px] mt-2"),
  h5: heading(6, "text-[14px] mt-2"),
  h6: heading(6, "text-[14px] mt-2"),
  ul: ({ children }) => <ul className="list-disc pl-5 space-y-1 marker:text-dim">{children}</ul>,
  ol: ({ children }) => (
    <ol className="list-decimal pl-6 space-y-1 marker:text-dim marker:tabular-nums">{children}</ol>
  ),
  li: ({ children }) => <li className="pl-0.5 [&>ul]:mt-1 [&>ol]:mt-1">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-white/[0.16] pl-3.5 text-muted">{children}</blockquote>
  ),
  hr: () => <hr className="border-white/[0.07] my-2" />,
  a: ({ href, children }) => {
    if (href && href.startsWith("file://")) {
      const cleanPath = decodeURIComponent(href.replace(/^file:\/\//, ""));
      return (
        <span
          title={cleanPath}
          className="inline-flex items-center gap-1 px-1.5 py-[1px] rounded-[5px] bg-white/[0.045] border border-white/[0.09] text-accent-soft font-mono text-[0.86em] align-baseline break-all"
        >
          <FileCode2 className="w-3 h-3 shrink-0 inline opacity-80" />
          <span>{children}</span>
        </span>
      );
    }
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-accent-soft hover:underline underline-offset-3 decoration-accent-soft/40 break-all"
      >
        {children}
      </a>
    );
  },
  table: ({ children }) => (
    <div className="my-2.5 overflow-x-auto rounded-xl border border-white/[0.08] max-w-full">
      <table className="w-full text-left text-[13px] border-collapse">{children}</table>
    </div>
  ),
  thead: ({ children }) => (
    <thead className="bg-white/[0.03] text-fg text-[12px] border-b border-white/[0.08]">
      {children}
    </thead>
  ),
  tr: ({ children }) => (
    <tr className="border-b border-white/[0.06] last:border-b-0">{children}</tr>
  ),
  th: ({ children }) => <th className="px-2.5 py-1.5 font-semibold">{children}</th>,
  td: ({ children }) => <td className="px-2.5 py-1.5 align-top">{children}</td>,
  img: ({ src, alt }) =>
    src && /^https?:\/\//i.test(src) ? (
      <a
        href={src}
        target="_blank"
        rel="noopener noreferrer"
        className="text-accent-soft underline underline-offset-2 break-all"
      >
        {alt || src}
      </a>
    ) : (
      <span className="text-muted italic">[image{alt ? `: ${alt}` : ""}]</span>
    ),
};
