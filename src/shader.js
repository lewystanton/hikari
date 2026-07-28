/* Hikari — ambient workspace shader.
   Quiet, warm/cool drifting field confined to the workspace pane —
   a wash of sun on paper (top right), a cool shadow pooling low,
   and the faintest vermilion breath along the fold lines. */
'use strict';

/* Load webfonts without blocking first paint. */
(function loadFonts() {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = 'https://fonts.googleapis.com/css2?family=Archivo:wght@500;600;700;800&family=Hanken+Grotesk:wght@300..700&family=JetBrains+Mono:wght@400;500;600&family=Zen+Old+Mincho:wght@400;700&display=swap';
  document.head.appendChild(link);
})();

function startShader(canvas) {
  const gl = canvas.getContext('webgl', { antialias: false, alpha: true, depth: false, stencil: false });
  if (!gl) { canvas.remove(); return; }

  const VERT = 'attribute vec2 p; void main(){ gl_Position = vec4(p,0.0,1.0); }';

  const FRAG = `
    precision highp float;
    uniform vec2 u_res;
    uniform float u_t;

    float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float noise(vec2 p){
      vec2 i = floor(p), f = fract(p);
      float a = hash(i), b = hash(i + vec2(1.0, 0.0)), c = hash(i + vec2(0.0, 1.0)), d = hash(i + vec2(1.0, 1.0));
      vec2 u = f * f * (3.0 - 2.0 * f);
      return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
    }
    float fbm(vec2 p){
      float v = 0.0, a = 0.5;
      for (int i = 0; i < 5; i++) { v += a * noise(p); p *= 2.02; a *= 0.5; }
      return v;
    }

    void main(){
      vec2 uv = gl_FragCoord.xy / u_res.xy;
      vec2 q = uv * 1.7; q.x *= u_res.x / u_res.y;
      float t = u_t * 0.035;

      float f = fbm(q + vec2(t, t * 0.6) + fbm(q * 1.25 - t * 0.5));
      float g = fbm(q * 0.8 - vec2(t * 0.7, t));
      float h = fbm(q * 0.55 + vec2(-t * 0.4, t * 0.8) + f * 0.6);

      vec3 base  = vec3(0.055, 0.051, 0.045);     // warm cinema black
      vec3 ember = vec3(0.170, 0.086, 0.055);     // banked ember
      vec3 slate = vec3(0.055, 0.075, 0.100);     // cold projector spill
      vec3 shu   = vec3(1.000, 0.310, 0.160);     // vermilion filament

      vec3 col = base;
      col = mix(col, ember, smoothstep(0.44, 0.96, f) * 0.55);
      col = mix(col, slate, smoothstep(0.50, 0.97, g) * 0.42);

      // vermilion only along narrow fold ridges — faint filaments in the dark
      float ridge = 1.0 - abs(2.0 * h - 1.0);
      col += shu * pow(clamp(ridge, 0.0, 1.0), 14.0) * 0.055;

      // light falls from above, pools into black below
      col += (1.0 - uv.y) * 0.012;
      float d = distance(uv, vec2(0.5, 0.45));
      col -= d * d * 0.035;

      gl_FragColor = vec4(col, 1.0);
    }
  `;

  const sh = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.error(gl.getShaderInfoLog(s));
      return null;
    }
    return s;
  };

  const vs = sh(gl.VERTEX_SHADER, VERT);
  const fs = sh(gl.FRAGMENT_SHADER, FRAG);
  if (!vs || !fs) { canvas.remove(); return; }

  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.useProgram(prog);

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'p');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

  const uRes = gl.getUniformLocation(prog, 'u_res');
  const uT = gl.getUniformLocation(prog, 'u_t');

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.25);
    canvas.width = Math.max(2, Math.floor(canvas.clientWidth * dpr * 0.5));
    canvas.height = Math.max(2, Math.floor(canvas.clientHeight * dpr * 0.5));
    gl.viewport(0, 0, canvas.width, canvas.height);
  }
  resize();

  /* v7 ghost: the blurred-artwork ambient sits on top of this field, so the
     old per-frame drift is invisible — render ONE static frame (a fixed point
     in the noise field) and redraw only on resize. Zero steady-state GPU cost;
     at 240Hz the whole frame budget goes to the UI. */
  const T = 137.4; // an arbitrary, pleasing point in the field
  function draw() {
    gl.uniform2f(uRes, canvas.width, canvas.height);
    gl.uniform1f(uT, T);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  new ResizeObserver(() => { resize(); draw(); }).observe(canvas);
  requestAnimationFrame(draw);
}
