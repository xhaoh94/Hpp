/**
 * Emoji rendering utility.
 * - Detects if system has emoji font support
 * - Falls back to Twemoji CDN if system emoji unavailable
 */

const TWEMOJI_BASE = 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/svg/';

// Regex to match emoji characters
const EMOJI_REGEX = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1FA00}-\u{1FAFF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu;

/**
 * Detect if the system can render emoji characters properly.
 * Uses canvas to check if emoji renders with actual pixels (not tofu/box).
 */
function detectEmojiSupport(): boolean {
  if (typeof document === 'undefined') return false;

  try {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return false;

    canvas.width = 20;
    canvas.height = 20;

    // Draw a test emoji
    ctx.font = '16px serif';
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#000';
    ctx.fillText('📦', 0, 0);

    // Check if any pixels are non-transparent (emoji rendered)
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;

    for (let i = 0; i < data.length; i += 4) {
      const alpha = data[i + 3]; // Alpha channel
      // If we find a pixel with some transparency (not fully transparent),
      // the emoji likely rendered
      if (alpha > 10 && alpha < 250) {
        return true;
      }
    }

    return false;
  } catch {
    return false;
  }
}

// Cache the result (only detect once)
let _emojiSupported: boolean | null = null;

function isEmojiSupported(): boolean {
  if (_emojiSupported === null) {
    _emojiSupported = detectEmojiSupport();
  }
  return _emojiSupported;
}

/**
 * Convert a single emoji character to its Twemoji codepoint filename.
 * Handles surrogate pairs for characters outside the BMP.
 */
function toCodePoint(emoji: string): string {
  const codepoints: string[] = [];

  for (let i = 0; i < emoji.length; i++) {
    const code = emoji.charCodeAt(i);

    // Handle surrogate pairs (characters > U+FFFF)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = emoji.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        const high = code - 0xd800;
        const low = next - 0xdc00;
        const codepoint = (high << 10) + low + 0x10000;
        codepoints.push(codepoint.toString(16));
        i++; // Skip the low surrogate
        continue;
      }
    }

    // Skip variation selectors and ZWJ
    if (code === 0xfe0f || code === 0xfe0e || code === 0x200d) {
      continue;
    }

    codepoints.push(code.toString(16));
  }

  return codepoints.join('-');
}

/**
 * Replace emoji characters in a string with Twemoji <img> elements.
 * Only replaces if system doesn't support emoji natively.
 */
export function replaceEmojiWithImages(text: string): string {
  // If system supports emoji, return as-is
  if (isEmojiSupported()) {
    return text;
  }

  // Otherwise, replace with Twemoji images
  return text.replace(EMOJI_REGEX, (match) => {
    const codePoint = toCodePoint(match);
    return `<img class="emoji-icon" draggable="false" alt="${match}" src="${TWEMOJI_BASE}${codePoint}.png" width="14" height="14" />`;
  });
}

/**
 * Check if a string contains emoji characters.
 */
export function hasEmoji(text: string): boolean {
  return EMOJI_REGEX.test(text);
}
