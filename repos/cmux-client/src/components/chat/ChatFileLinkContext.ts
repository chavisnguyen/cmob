import { createContext, useContext } from "react";

/** Opens a markdown file path mentioned in chat (null when no viewer is available). */
export type OpenChatFile = (path: string) => void;

export const ChatFileLinkContext = createContext<OpenChatFile | null>(null);

export function useOpenChatFile(): OpenChatFile | null {
  return useContext(ChatFileLinkContext);
}
