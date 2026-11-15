import { Children, isValidElement, useState, type ReactElement, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy } from "lucide-react";

interface NativeChatProseProps {
  content: string;
}

const REMARK_PLUGINS = [remarkGfm];

/** Agent output rendered as GitHub-flavoured markdown. Raw HTML is never interpreted (react-markdown default). */
export function NativeChatProse({ content }: NativeChatProseProps) {
  return (
    <div className="space-y-2.5 text-[14.5px] text-gray-200 leading-[1.6] break-words [overflow-wrap:anywhere] min-w-0 max-w-full">
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={COMPONENTS}>
        {content}
      </ReactMarkdown>
    </div>
  );
}

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
    <div className="my-2 rounded-lg overflow-hidden border border-[#2e303a] bg-[#121319] text-xs font-mono min-w-0 max-w-full">
      <div className="flex items-center justify-between px-3 py-1.5 bg-[#191a24] border-b border-[#2e303a] text-gray-400">
        <span className="text-[11px] font-semibold lowercase">{lang || "text"}</span>
        <button
          type="button"
          onClick={handleCopy}
          className="flex items-center gap-1 hover:text-white transition-colors"
          title="Copy code"
        >
          {copied ? (
            <Check className="w-3.5 h-3.5 text-emerald-400" />
          ) : (
            <Copy className="w-3.5 h-3.5" />
          )}
          <span className="text-[10px]">{copied ? "Copied" : "Copy"}</span>
        </button>
      </div>
      <pre className="p-3 overflow-x-auto text-gray-300 leading-normal scrollbar-thin max-w-full">
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
  // Fenced code: react-markdown renders <pre><code class="language-x">…</code></pre>.
  pre({ children }) {
    const child = Children.toArray(children)[0];
    const props = isValidElement(child)
      ? (child as ReactElement<{ className?: string; children?: ReactNode }>).props
      : {};
    const lang = /language-([\w-]+)/.exec(props.className ?? "")?.[1];
    return <CodeBlock code={textOf(props.children).replace(/\n$/, "")} lang={lang} />;
  },
  code({ children, className }) {
    // Inline code only: block code is consumed by `pre` above and never reaches here.
    return (
      <code
        className={`px-1.5 py-0.5 rounded bg-[#272935] text-indigo-300 font-mono text-[12px] break-all [overflow-wrap:anywhere] ${className ?? ""}`}
      >
        {children}
      </code>
    );
  },
  p: ({ children }) => <p className="break-words [overflow-wrap:anywhere]">{children}</p>,
  strong: ({ children }) => <strong className="font-semibold text-white">{children}</strong>,
  del: ({ children }) => <del className="text-gray-400">{children}</del>,
  h1: heading(2, "text-[17px] mt-3"),
  h2: heading(3, "text-[16px] mt-2.5"),
  h3: heading(4, "text-[15px] mt-2"),
  h4: heading(5, "text-[15px] mt-2"),
  h5: heading(6, "text-[15px] mt-2"),
  h6: heading(6, "text-[15px] mt-2"),
  ul: ({ children }) => (
    <ul className="list-disc pl-5 space-y-1 marker:text-gray-400">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="list-decimal pl-6 space-y-1 marker:text-gray-400 marker:tabular-nums">
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="pl-0.5 [&>ul]:mt-1 [&>ol]:mt-1">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-indigo-400/50 pl-3 text-gray-300">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="border-white/10 my-1" />,
  a: ({ href, children }) => {
    const safe = typeof href === "string" && /^https?:\/\//i.test(href);
    return safe ? (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-[#8ab4f8] underline underline-offset-2 break-all"
      >
        {children}
      </a>
    ) : (
      <span>{children}</span>
    );
  },
  // Remote images would be fetched (and could track) just by reading a chat message: show a link instead.
  img: ({ src, alt }) => {
    const safe = typeof src === "string" && /^https?:\/\//i.test(src);
    return safe ? (
      <a
        href={src}
        target="_blank"
        rel="noopener noreferrer"
        className="text-[#8ab4f8] underline underline-offset-2 break-all"
      >
        {alt || "image"}
      </a>
    ) : (
      <span>{alt || "image"}</span>
    );
  },
  table: ({ children }) => (
    <div className="overflow-x-auto rounded-lg border border-white/10 max-w-full">
      <table className="text-[13px] border-collapse min-w-full">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-white/[0.05]">{children}</thead>,
  tr: ({ children }) => (
    <tr className="border-t border-white/10 first:border-t-0 align-top">{children}</tr>
  ),
  th: ({ children }) => (
    <th className="px-2.5 py-1.5 text-left font-semibold text-white whitespace-nowrap">
      {children}
    </th>
  ),
  td: ({ children }) => <td className="px-2.5 py-1.5 min-w-[5rem]">{children}</td>,
};
