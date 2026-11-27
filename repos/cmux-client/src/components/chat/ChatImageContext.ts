import { createContext, useContext } from "react";

/** Resolves a transcript image id to a `data:` URL (null when no session is available). */
export type FetchChatImage = (imageId: string) => Promise<string>;

export const ChatImageContext = createContext<FetchChatImage | null>(null);

export function useFetchChatImage(): FetchChatImage | null {
  return useContext(ChatImageContext);
}
