// Lizzie'nin yüzü: önden bakan minik mor bir tren. Ruh hali, kök <svg>'ye verilen
// m-happy / m-calm / m-alert / m-worried / m-sad / m-sleepy sınıfıyla değişir (style.css).

const INK = '#2A2342';

export const FACE_SVG = `
<svg class="face" viewBox="0 0 64 64" aria-hidden="true">
  <rect class="rail" x="4" y="59.5" width="56" height="2" rx="1"/>
  <g class="bob">
    <rect class="body" x="9" y="6" width="46" height="49" rx="15"/>
    <rect x="24" y="9.2" width="16" height="3.2" rx="1.6" fill="#CDBDF6"/>
    <rect x="14" y="15" width="36" height="20.5" rx="8.5" fill="${INK}"/>
    <g class="e-open">
      <ellipse cx="25" cy="25.5" rx="3.7" ry="4.5" fill="#fff"/>
      <ellipse cx="39" cy="25.5" rx="3.7" ry="4.5" fill="#fff"/>
      <circle cx="25.5" cy="26.2" r="2.4" fill="${INK}"/>
      <circle cx="39.5" cy="26.2" r="2.4" fill="${INK}"/>
      <circle cx="26.5" cy="25" r=".9" fill="#fff"/>
      <circle cx="40.5" cy="25" r=".9" fill="#fff"/>
    </g>
    <g class="e-happy" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round">
      <path d="M21.2 27.5 Q25 21.8 28.8 27.5"/>
      <path d="M35.2 27.5 Q39 21.8 42.8 27.5"/>
    </g>
    <g class="e-closed" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round">
      <path d="M21.5 25.5 Q25 28.8 28.5 25.5"/>
      <path d="M35.5 25.5 Q39 28.8 42.5 25.5"/>
    </g>
    <g class="brows" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round">
      <path d="M21 20.6 L28 18.8"/>
      <path d="M43 20.6 L36 18.8"/>
    </g>
    <ellipse cx="18.3" cy="42.5" rx="3.6" ry="2.2" fill="#FF9EC7" opacity=".8"/>
    <ellipse cx="45.7" cy="42.5" rx="3.6" ry="2.2" fill="#FF9EC7" opacity=".8"/>
    <path class="mo-smile" d="M28 41 Q32 45.2 36 41" fill="none" stroke="${INK}" stroke-width="2.2" stroke-linecap="round"/>
    <g class="mo-grin">
      <path d="M27 40.3 Q32 48.5 37 40.3 Z" fill="${INK}" stroke="${INK}" stroke-width="1" stroke-linejoin="round"/>
      <ellipse cx="32" cy="44.6" rx="2.3" ry="1.2" fill="#FF8FB1"/>
    </g>
    <ellipse class="mo-o" cx="32" cy="42.6" rx="2.5" ry="2.9" fill="${INK}"/>
    <path class="mo-wavy" d="M27 43 q1.25 -1.8 2.5 0 t2.5 0 t2.5 0 t2.5 0" fill="none" stroke="${INK}" stroke-width="2" stroke-linecap="round"/>
    <path class="mo-frown" d="M28 44.2 Q32 40 36 44.2" fill="none" stroke="${INK}" stroke-width="2.2" stroke-linecap="round"/>
    <circle class="lamp" cx="16.5" cy="49" r="2.3"/>
    <circle class="lamp" cx="47.5" cy="49" r="2.3"/>
    <rect x="15" y="54" width="34" height="4" rx="2" fill="${INK}" opacity=".85"/>
    <path class="x-sweat" d="M52.5 13 C52.5 13 49 17.4 49 19.5 a3.5 3.5 0 0 0 7 0 C56 17.4 52.5 13 52.5 13Z" fill="#8FD8FF"/>
    <path class="x-tear" d="M43.5 29 C43.5 29 41.3 32 41.3 33.4 a2.2 2.2 0 0 0 4.4 0 C45.7 32 43.5 29 43.5 29Z" fill="#8FD8FF"/>
    <path class="x-sparkle" d="M56 2.5 L57.3 6.2 L61 7.5 L57.3 8.8 L56 12.5 L54.7 8.8 L51 7.5 L54.7 6.2 Z" fill="#FFD166"/>
  </g>
  <g class="x-zzz" fill="currentColor" font-weight="900" font-family="Nunito, sans-serif">
    <text x="51" y="10" font-size="9">z</text>
    <text x="57" y="5" font-size="6">z</text>
  </g>
</svg>`;

// Zaman çizelgesindeki hedef tren: sola (kapıya) doğru giden minik vagon.
export const MINI_TRAIN = `
<svg viewBox="0 0 22 14" aria-hidden="true">
  <path d="M5 1 H19 a2 2 0 0 1 2 2 V10 a1 1 0 0 1 -1 1 H2 a1 1 0 0 1 -1 -1 V6 a5 5 0 0 1 4 -5Z" fill="#6950A1"/>
  <path d="M3.2 5.6 A3.6 3.6 0 0 1 6 3 H8 V6.4 H3.2Z" fill="${INK}"/>
  <rect x="10" y="3" width="3.4" height="3.4" rx="1" fill="#CDBDF6"/>
  <rect x="15" y="3" width="3.4" height="3.4" rx="1" fill="#CDBDF6"/>
  <circle cx="5.5" cy="12.4" r="1.5" fill="${INK}"/>
  <circle cx="16.5" cy="12.4" r="1.5" fill="${INK}"/>
</svg>`;
