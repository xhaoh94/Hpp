import { useEffect, useState } from "react";

// Braille dot positions for each frame, derived from the original
// Braille character Unicode code points (⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏).
// Each value is a 6-bit mask: bit5=dot1 bit4=dot4 bit3=dot2 bit2=dot5 bit1=dot3 bit0=dot6
// Grid layout:  dot1 (pos0) | dot4 (pos1)
//               dot2 (pos2) | dot5 (pos3)
//               dot3 (pos4) | dot6 (pos5)
const BRAILLE_FRAMES = [
  0b111000, // ⠋ dots 1,2,4
  0b110100, // ⠙ dots 1,4,5
  0b110101, // ⠹ dots 1,4,5,6
  0b010101, // ⠸ dots 4,5,6
  0b010111, // ⠼ dots 3,4,5,6
  0b000111, // ⠴ dots 3,5,6
  0b001011, // ⠦ dots 2,3,6
  0b101011, // ⠧ dots 1,2,3,6
  0b101010, // ⠇ dots 1,2,3
  0b111010, // ⠏ dots 1,2,3,4
];

export function BrailleSpinner() {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const timer = setInterval(
      () => setFrame((f) => (f + 1) % BRAILLE_FRAMES.length),
      80,
    );
    return () => clearInterval(timer);
  }, []);

  const mask = BRAILLE_FRAMES[frame];

  return (
    <span className="braille-dot-spinner" role="status" aria-label="运行中">
      {Array.from({ length: 6 }, (_, i) => (
        <span
          key={i}
          className="braille-dot"
          style={{ opacity: mask & (1 << (5 - i)) ? 1 : 0 }}
        />
      ))}
    </span>
  );
}
