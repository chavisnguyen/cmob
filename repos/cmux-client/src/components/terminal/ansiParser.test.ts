import { describe, it, expect } from "vite-plus/test";
import React from "react";
import { parseAnsiToReact, stripNonSgrAnsi } from "./ansiParser";

interface StyledProps {
  style?: React.CSSProperties;
  children?: React.ReactNode;
}

function asElement(node: React.ReactNode): React.ReactElement<StyledProps> {
  return node as React.ReactElement<StyledProps>;
}

describe("stripNonSgrAnsi", () => {
  it("strips cursor movement and screen clear sequences", () => {
    const raw = "\x1b[2J\x1b[HHello \x1b[?25hWorld\x1b[K";
    expect(stripNonSgrAnsi(raw)).toBe("Hello World");
  });

  it("strips OSC window title sequences", () => {
    const raw = "\x1b]0;my-window-title\x07echo 'done'";
    expect(stripNonSgrAnsi(raw)).toBe("echo 'done'");
  });
});

describe("parseAnsiToReact", () => {
  it("returns plain string array when no ANSI codes exist", () => {
    const result = parseAnsiToReact("Plain terminal line");
    expect(result).toEqual(["Plain terminal line"]);
  });

  it("parses standard foreground colors (red, green, cyan)", () => {
    const raw = "\x1b[31mError:\x1b[0m \x1b[32mSuccess\x1b[0m \x1b[36mInfo\x1b[0m";
    const result = parseAnsiToReact(raw);

    expect(result.length).toBe(5);
    // Error: in red
    expect(React.isValidElement(result[0])).toBe(true);
    expect(asElement(result[0]).props.style?.color).toBe("#ef4444");
    expect(asElement(result[0]).props.children).toBe("Error:");

    // Space
    expect(result[1]).toBe(" ");

    // Success in green
    expect(React.isValidElement(result[2])).toBe(true);
    expect(asElement(result[2]).props.style?.color).toBe("#22c55e");
    expect(asElement(result[2]).props.children).toBe("Success");

    // Space
    expect(result[3]).toBe(" ");

    // Info in cyan
    expect(React.isValidElement(result[4])).toBe(true);
    expect(asElement(result[4]).props.style?.color).toBe("#06b6d4");
    expect(asElement(result[4]).props.children).toBe("Info");
  });

  it("parses bold and underline styles", () => {
    const raw = "\x1b[1;4mBold Underline\x1b[0m";
    const result = parseAnsiToReact(raw);

    expect(result.length).toBe(1);
    expect(React.isValidElement(result[0])).toBe(true);
    const style = asElement(result[0]).props.style;
    expect(style?.fontWeight).toBe("bold");
    expect(style?.textDecoration).toBe("underline");
    expect(asElement(result[0]).props.children).toBe("Bold Underline");
  });

  it("parses 256-color palette (38;5;N)", () => {
    const raw = "\x1b[38;5;196mBrightRed256\x1b[0m";
    const result = parseAnsiToReact(raw);

    expect(result.length).toBe(1);
    expect(React.isValidElement(result[0])).toBe(true);
    expect(asElement(result[0]).props.style?.color).toMatch(/rgb\(|#/);
    expect(asElement(result[0]).props.children).toBe("BrightRed256");
  });

  it("parses 24-bit Truecolor (38;2;R;G;B)", () => {
    const raw = "\x1b[38;2;120;200;80mTrueColor\x1b[0m";
    const result = parseAnsiToReact(raw);

    expect(result.length).toBe(1);
    expect(React.isValidElement(result[0])).toBe(true);
    expect(asElement(result[0]).props.style?.color).toBe("rgb(120, 200, 80)");
    expect(asElement(result[0]).props.children).toBe("TrueColor");
  });
});
