// Lizzie'nin yüzü: önden bakan sade bir mor tren. Açık renk camın üstünde iki göz,
// gövdede bir ağız; 34 pikselde de okunsun diye başka süs yok. Ruh hali kök <svg>'ye
// verilen m-happy / m-calm / m-alert / m-worried / m-sad / m-sleepy sınıfıyla değişir.

const INK = '#2A2342';
const eyes = (body) => `fill="none" stroke="${INK}" stroke-width="2" stroke-linecap="round">${body}`;
const mouth = 'fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round"';

export const FACE_SVG = `
<svg class="face" viewBox="0 0 40 40" aria-hidden="true">
  <g class="bob">
    <rect class="body" x="5" y="3" width="30" height="31" rx="10"/>
    <rect class="glass" x="9" y="7" width="22" height="13" rx="5"/>
    <g class="e-open" fill="${INK}"><circle cx="15.5" cy="13.5" r="2.2"/><circle cx="24.5" cy="13.5" r="2.2"/></g>
    <g class="e-happy" ${eyes('<path d="M13.3 14.6 Q15.5 11.2 17.7 14.6"/><path d="M22.3 14.6 Q24.5 11.2 26.7 14.6"/>')}</g>
    <g class="e-closed" ${eyes('<path d="M13.5 13.8 H17.5"/><path d="M22.5 13.8 H26.5"/>')}</g>
    <path class="mo-smile" d="M16 24.2 Q20 28.2 24 24.2" ${mouth}/>
    <path class="mo-flat" d="M16.5 25.6 H23.5" ${mouth}/>
    <path class="mo-frown" d="M16 27 Q20 23.2 24 27" ${mouth}/>
    <ellipse class="mo-o" cx="20" cy="25.4" rx="2.1" ry="2.5" fill="#fff"/>
    <circle class="lamp" cx="10.5" cy="29.5" r="1.9"/>
    <circle class="lamp" cx="29.5" cy="29.5" r="1.9"/>
    <rect x="11" y="34" width="18" height="3" rx="1.5" fill="${INK}"/>
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
