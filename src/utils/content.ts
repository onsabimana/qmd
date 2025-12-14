/**
 * Content utilities - hashing, title extraction, and chunking
 */

import { CHUNK_BYTE_SIZE } from "src/config";

/**
 * Hash content using SHA-256
 */
export async function hashContent(content: string): Promise<string> {
  const hash = new Bun.CryptoHasher("sha256");
  hash.update(content);
  return hash.digest("hex");
}

/**
 * Extract title from markdown content
 */
export function extractTitle(content: string, filename: string): string {
  const match = content.match(/^##?\s+(.+)$/m);
  if (match) {
    const title = match[1].trim();
    if (title === "📝 Notes" || title === "Notes") {
      const nextMatch = content.match(/^##\s+(.+)$/m);
      if (nextMatch) return nextMatch[1].trim();
    }
    return title;
  }
  return filename.replace(/\.md$/, "").split("/").pop() || filename;
}

/**
 * Chunk document content into smaller pieces with smart boundary detection
 */
export function chunkDocument(content: string, maxBytes: number = CHUNK_BYTE_SIZE): { text: string; pos: number }[] {
  const encoder = new TextEncoder();
  const totalBytes = encoder.encode(content).length;

  if (totalBytes <= maxBytes) {
    return [{ text: content, pos: 0 }];
  }

  const chunks: { text: string; pos: number }[] = [];
  let charPos = 0;

  while (charPos < content.length) {
    let endPos = charPos;
    let byteCount = 0;

    while (endPos < content.length && byteCount < maxBytes) {
      const charBytes = encoder.encode(content[endPos]).length;
      if (byteCount + charBytes > maxBytes) break;
      byteCount += charBytes;
      endPos++;
    }

    if (endPos < content.length && endPos > charPos) {
      const slice = content.slice(charPos, endPos);
      const paragraphBreak = slice.lastIndexOf("\n\n");
      const sentenceEnd = Math.max(
        slice.lastIndexOf(". "),
        slice.lastIndexOf(".\n"),
        slice.lastIndexOf("? "),
        slice.lastIndexOf("?\n"),
        slice.lastIndexOf("! "),
        slice.lastIndexOf("!\n"),
      );
      const lineBreak = slice.lastIndexOf("\n");
      const spaceBreak = slice.lastIndexOf(" ");

      let breakPoint = -1;
      if (paragraphBreak > slice.length * 0.5) {
        breakPoint = paragraphBreak + 2;
      } else if (sentenceEnd > slice.length * 0.5) {
        breakPoint = sentenceEnd + 2;
      } else if (lineBreak > slice.length * 0.3) {
        breakPoint = lineBreak + 1;
      } else if (spaceBreak > slice.length * 0.3) {
        breakPoint = spaceBreak + 1;
      }

      if (breakPoint > 0) {
        endPos = charPos + breakPoint;
      }
    }

    if (endPos <= charPos) {
      endPos = charPos + 1;
    }

    chunks.push({ text: content.slice(charPos, endPos), pos: charPos });
    charPos = endPos;
  }

  return chunks;
}
