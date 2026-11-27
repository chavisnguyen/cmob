# Viewing prompt images in chat (Claude transcripts)

## Verified (2026-11-27)
- Claude user prompts store images inline in the transcript JSONL: `message.content[]` blocks `{"type":"image","source":{"type":"base64","media_type":"image/png|jpeg|webp","data":"…"}}`. Scan of the 150 newest transcripts under `~/.claude/projects`: 133 user image blocks (png 95, jpeg 20, webp 18), base64 length min 18 K / median 139 K / max 660 K chars. Typical prompt shapes: `[text "[Image #1]", image]`, `[image, text]`. (Many other lines contain images only inside `tool_result` blocks; those are not user bubbles and are ignored.)
- Gateway WebSocket message limit is 2 MiB (`transport/ws_session.rs:41`), so bytes are fetched one image at a time and capped at 1.5 M base64 chars.
- Codex: `~/.codex/sessions` grep for `input_image` found nothing; format NOT verified → images only for Claude for now. Codex/Antigravity prompts still show the `🖼 Image N` badge.

## Implementation
- Event: `AgentEvent::UserImage { image_id, media_type }` (`protocol/event.rs`), emitted by `providers/claude.rs` after the `User` event of the same turn; `image_id = "<line uuid>#<index among image blocks>"`. No bytes in chat payloads (test `user_images_become_refs_without_bytes`). Skipped when the transcript line has no `uuid`.
- RPC `mobile.chat.readImage` `{surface_id, session_id, image_id}` → `{media_type, data}` (`transport/rpc/chat.rs`, `services/transcript_image.rs`). Transcript path comes from `SessionStateService::resolve_session_raw`, never from the client. Allowed types png/jpeg/webp/gif (svg rejected), id restricted to `[A-Za-z0-9-]#<n<256>`.
- Client: `protocol/event.ts` (`user-image`), `domain/chat/chatViewModel.ts` (`images`, drops the badge when real images exist), `components/chat/{ChatImages,chatImageCache,ChatImageContext}.ts(x)` (lazy fetch when scrolled near, 24-entry cache, lightbox via portal), provider in `views/SurfaceDetailView.tsx`. Optimistic previews of just-sent images use the same tappable thumbnail.
- E2E (own gateway on :18099, real sessions): 3 sessions with 3/2/1 images; `readImage` returned a real JPEG (152 835 bytes, magic `ffd8ffe0`); unknown id → "Image not found…", malformed id → "Invalid image id.".

## Not done
- Images referenced by path (agent screenshots, markdown `![](path)`): would reuse the `mobile.file.read` containment rules with image extensions.
- Codex/Antigravity/OpenCode prompt images; images inside tool results.
