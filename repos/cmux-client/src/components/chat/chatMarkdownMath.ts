import { defaultUrlTransform } from "react-markdown";

const LATEX_SYMBOLS: ReadonlyArray<[RegExp, string]> = [
  [/\\Longleftrightarrow|\\iff/g, "⟺"],
  [/\\leftrightarrow/g, "↔"],
  [/\\Leftrightarrow/g, "⇔"],
  [/\\longrightarrow|\\rightarrow|\\to(?![a-zA-Z])/g, "→"],
  [/\\Longrightarrow|\\Rightarrow|\\implies/g, "⇒"],
  [/\\longleftarrow|\\leftarrow|\\gets(?![a-zA-Z])/g, "←"],
  [/\\Longleftarrow|\\Leftarrow/g, "⇐"],
  [/\\mapsto/g, "↦"],
  [/\\uparrow/g, "↑"],
  [/\\downarrow/g, "↓"],
  [/\\times/g, "×"],
  [/\\div(?![a-zA-Z])/g, "÷"],
  [/\\cdot/g, "·"],
  [/\\pm(?![a-zA-Z])/g, "±"],
  [/\\mp(?![a-zA-Z])/g, "∓"],
  [/\\leq|\\le(?![a-zA-Z])/g, "≤"],
  [/\\geq|\\ge(?![a-zA-Z])/g, "≥"],
  [/\\neq|\\ne(?![a-zA-Z])/g, "≠"],
  [/\\approx/g, "≈"],
  [/\\equiv/g, "≡"],
  [/\\sim(?![a-zA-Z])/g, "∼"],
  [/\\infty/g, "∞"],
  [/\\forall/g, "∀"],
  [/\\exists/g, "∃"],
  [/\\in(?![a-zA-Z])/g, "∈"],
  [/\\notin/g, "∉"],
  [/\\subset(?![a-zA-Z])/g, "⊂"],
  [/\\subseteq/g, "⊆"],
  [/\\cup(?![a-zA-Z])/g, "∪"],
  [/\\cap(?![a-zA-Z])/g, "∩"],
  [/\\emptyset|\\varnothing/g, "∅"],
  [/\\sum(?![a-zA-Z])/g, "∑"],
  [/\\prod(?![a-zA-Z])/g, "∏"],
  [/\\sqrt\{([^{}]+)\}/g, "√($1)"],
  [/\\sqrt(?![a-zA-Z])/g, "√"],
  [/\\frac\{([^{}]+)\}\{([^{}]+)\}/g, "($1/$2)"],
  [/\\(?:text|mathrm|mathbf|mathit|mathtt)\{([^{}]*)\}/g, "$1"],
  [/\\alpha(?![a-zA-Z])/g, "α"],
  [/\\beta(?![a-zA-Z])/g, "β"],
  [/\\gamma(?![a-zA-Z])/g, "γ"],
  [/\\delta(?![a-zA-Z])/g, "δ"],
  [/\\Delta(?![a-zA-Z])/g, "Δ"],
  [/\\epsilon|\\varepsilon/g, "ε"],
  [/\\theta(?![a-zA-Z])/g, "θ"],
  [/\\lambda(?![a-zA-Z])/g, "λ"],
  [/\\mu(?![a-zA-Z])/g, "μ"],
  [/\\pi(?![a-zA-Z])/g, "π"],
  [/\\sigma(?![a-zA-Z])/g, "σ"],
  [/\\omega(?![a-zA-Z])/g, "ω"],
  [/\\Omega(?![a-zA-Z])/g, "Ω"],
  [/\\dots|\\ldots/g, "…"],
  [/\\cdots/g, "⋯"],
  [/\\checkmark/g, "✓"],
];

function convertLatexExpr(expr: string): string {
  let out = expr.trim();
  for (const [pattern, replacement] of LATEX_SYMBOLS) {
    out = out.replace(pattern, replacement);
  }
  out = out.replace(/\\([%$&_#{}])/g, "$1");
  return out;
}

/**
 * Normalizes inline `$...$` / `$$...$$` LaTeX math (e.g. `$\rightarrow$` -> `→`) outside fenced and
 * inline code spans so math notation emitted by Gemini/Claude renders cleanly without raw `$` noise.
 */
export function normalizeChatMarkdownMath(markdown: string): string {
  if (!markdown.includes("$")) return markdown;

  // Split by fenced code blocks and inline backticks so code is never touched.
  const segments = markdown.split(/(```[\s\S]*?```|`[^`\n]+`)/g);
  return segments
    .map((seg, idx) => {
      if (idx % 2 === 1) return seg;
      // Display math `$$...$$`
      let next = seg.replace(/\$\$([\s\S]+?)\$\$/g, (_m, body: string) => {
        if (!body.includes("\\") && !/[_^{}]/.test(body)) return _m;
        return convertLatexExpr(body);
      });
      // Inline math `$...$` (must contain a LaTeX backslash command or math operator, never currency `$10 ... $20`)
      next = next.replace(/\$([^\n$]{1,160}?)\$/g, (full, body: string) => {
        if (/^\d/.test(body.trim()) && !body.includes("\\")) return full;
        if (!body.includes("\\") && !/[_^{}]/.test(body)) return full;
        return convertLatexExpr(body);
      });
      return next;
    })
    .join("");
}

/**
 * Preserve `file://` destinations that `react-markdown`'s `defaultUrlTransform` would otherwise strip
 * to `""` (matching `ref/orca/src/renderer/src/components/native-chat/markdown/NativeChatMarkdown.tsx:59`).
 */
export function chatUrlTransform(url: string): string {
  if (url.startsWith("file://")) {
    return url;
  }
  return defaultUrlTransform(url);
}
